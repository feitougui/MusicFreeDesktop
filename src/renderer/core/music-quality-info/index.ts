import * as Comlink from "comlink";
import PQueue from "p-queue";
import axios from "axios";
import Store from "@/common/store";
import { getMediaPrimaryKey, getQualityOrder } from "@/common/media-util";
import { getGlobalContext } from "@shared/global-context/renderer";
import AppConfig from "@shared/app-config/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import { localPluginName } from "@/common/constant";
import logger from "@shared/logger/renderer";

/** 歌曲音质探测信息 */
export interface IMusicQualityInfo {
    /** 真实音质 */
    quality?: IMusic.IQualityKey;
    /** 是否 Hi-Res（super 音质） */
    isHiRes?: boolean;
    /** 格式（如 flac、mp3） */
    format?: string;
    /** 大小（字节） */
    size?: number;
    /** 探测状态 */
    state: "pending" | "loading" | "done" | "error";
}

interface IProbeWorker {
    getMediaInfo: (mediaSource: IMusic.IMusicSource) => Promise<{
        size?: number;
        contentType?: string;
        format?: string;
    } | null>;
}

const infoStore = new Store<Record<string, IMusicQualityInfo>>({});
const probedKeys = new Set<string>();

let worker: IProbeWorker | null = null;
let probeQueue: PQueue | null = null;

function ensureWorker() {
    if (worker) {
        return;
    }
    const workerPath = getGlobalContext().workersPath.downloader;
    if (workerPath) {
        const w = new Worker(workerPath);
        worker = Comlink.wrap(w) as unknown as IProbeWorker;
    } else {
        logger.logInfo("Worker path is not defined");
    }
}

function getProbeQueue() {
    if (!probeQueue) {
        probeQueue = new PQueue({
            concurrency: 3,
        });
    }
    return probeQueue;
}

const contentTypeExtMap: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
};

function normalizeFormat(
    contentType?: string,
    urlFormat?: string,
    quality?: IMusic.IQualityKey,
) {
    if (urlFormat) {
        return urlFormat;
    }
    if (contentType) {
        const ext = contentTypeExtMap[contentType.split(";")[0].trim()];
        if (ext) {
            return ext;
        }
    }
    if (quality === "super" || quality === "high") {
        return "flac";
    }
    return "mp3";
}

async function probeMusicItem(musicItem: IMusic.IMusicItem) {
    const key = getMediaPrimaryKey(musicItem);

    infoStore.setValue((prev) => ({
        ...prev,
        [key]: {
            ...(prev[key] ?? {}),
            state: "loading",
        },
    }));

    let finalInfo: IMusicQualityInfo = {
        state: "error",
    };

    try {
        // 不支持 getMediaSource 的本地音乐，直接读取文件信息
        if (musicItem.platform === localPluginName) {
            finalInfo = {
                state: "done",
                format: musicItem.url?.match(/\.([^./?#]+)$/)?.[1]?.toLowerCase(),
            };
        } else {
            // 按音质优先级依次尝试
            const [defaultQuality, whenMissing] = [
                AppConfig.getConfig("playMusic.defaultQuality"),
                AppConfig.getConfig("playMusic.whenQualityMissing"),
            ];
            const qualityOrder = getQualityOrder(defaultQuality, whenMissing);

            let realQuality: IMusic.IQualityKey | undefined;
            let mediaSource: IPlugin.IMediaSourceResult | null = null;

            for (const quality of qualityOrder) {
                try {
                    const source = await PluginManager.callPluginDelegateMethod(
                        { platform: musicItem.platform },
                        "getMediaSource",
                        musicItem,
                        quality,
                    );
                    if (source?.url) {
                        mediaSource = source;
                        realQuality = quality;
                        break;
                    }
                } catch {
                    // pass
                }
            }

            if (mediaSource?.url) {
                let size: number | undefined;
                let format: string | undefined;

                // 1. worker HEAD 探测
                ensureWorker();
                if (worker) {
                    try {
                        const info = await worker.getMediaInfo({
                            url: mediaSource.url,
                            headers: mediaSource.headers,
                            userAgent: mediaSource.userAgent,
                        });
                        size = info?.size;
                        format = info?.format;
                        if (!format && info?.contentType) {
                            format = normalizeFormat(info.contentType, undefined, realQuality);
                        }
                    } catch {
                        // pass
                    }
                }

                // 2. 兜底：直接 axios HEAD
                if (!size) {
                    try {
                        const resp = await axios.head(mediaSource.url, {
                            headers: {
                                ...(mediaSource.headers ?? {}),
                                ...(mediaSource.userAgent
                                    ? { "user-agent": mediaSource.userAgent }
                                    : {}),
                            },
                            timeout: 8000,
                        });
                        size =
                            +(resp.headers["content-length"] as string) || undefined;
                        if (!format) {
                            format = normalizeFormat(
                                resp.headers["content-type"] as string,
                                undefined,
                                realQuality,
                            );
                        }
                    } catch {
                        // pass
                    }
                }

                finalInfo = {
                    state: "done",
                    quality: realQuality,
                    isHiRes: realQuality === "super",
                    format: normalizeFormat(undefined, format, realQuality),
                    size,
                };
            }
        }
    } catch {
        finalInfo = { state: "error" };
    }

    infoStore.setValue((prev) => ({
        ...prev,
        [key]: finalInfo,
    }));
}

/** 将一批歌曲加入探测队列 */
export function requestQualityInfo(musicItems: IMusic.IMusicItem[]) {
    const queue = getProbeQueue();
    const current = infoStore.getValue();

    for (const item of musicItems) {
        if (!item) {
            continue;
        }
        const key = getMediaPrimaryKey(item);
        if (probedKeys.has(key)) {
            continue;
        }
        probedKeys.add(key);

        if (!current[key]) {
            infoStore.setValue((prev) => ({
                ...prev,
                [key]: { state: "pending" },
            }));
        }

        queue.add(() => probeMusicItem(item));
    }
}

/** 获取某首歌的音质信息 */
export function getQualityInfo(
    musicItem: IMusic.IMusicItem,
): IMusicQualityInfo | undefined {
    return infoStore.getValue()[getMediaPrimaryKey(musicItem)];
}

export function useQualityInfoMap() {
    return infoStore.useValue();
}

function formatSize(size?: number): string {
    if (!size || size <= 0) {
        return "";
    }
    const mb = size / (1024 * 1024);
    if (mb >= 1) {
        return `${mb.toFixed(1)}MB`;
    }
    return `${(size / 1024).toFixed(0)}KB`;
}

/** 生成展示文案：FLAC · 45.2MB · Hi-Res */
export function getQualityInfoText(info?: IMusicQualityInfo): string {
    if (!info) {
        return "";
    }
    if (info.state === "pending" || info.state === "loading") {
        return "...";
    }
    const parts: string[] = [];
    if (info.format) {
        parts.push(info.format.toUpperCase());
    }
    const sizeText = formatSize(info.size);
    if (sizeText) {
        parts.push(sizeText);
    }
    if (info.isHiRes) {
        parts.push("Hi-Res");
    }
    return parts.join(" · ");
}

export default {
    requestQualityInfo,
    getQualityInfo,
    useQualityInfoMap,
    getQualityInfoText,
};
