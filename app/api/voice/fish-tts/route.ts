import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const DEFAULT_MODEL = "s2.1-pro-free";
const ALLOWED_LATENCIES = new Set(["normal", "balanced", "low"]);
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

type FishTtsRequest = {
    text?: unknown;
    referenceId?: unknown;
    model?: unknown;
    latency?: unknown;
};

function errorResponse(error: string, message: string, status: number) {
    return NextResponse.json({ error, message }, { status });
}

export async function POST(request: Request) {
    const apiKey = request.headers.get("x-fish-audio-key")?.trim() || "";
    if (!apiKey) {
        return errorResponse("missing_api_key", "Fish Audio API key is required.", 400);
    }
    if (apiKey.length > 512) {
        return errorResponse("invalid_api_key", "Fish Audio API key is too long.", 400);
    }

    const body = await request.json().catch(() => null) as FishTtsRequest | null;
    if (!body) {
        return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const referenceId = typeof body.referenceId === "string" ? body.referenceId.trim() : "";
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const model = requestedModel || DEFAULT_MODEL;
    const requestedLatency = typeof body.latency === "string" ? body.latency.trim() : "";
    const latency = ALLOWED_LATENCIES.has(requestedLatency) ? requestedLatency : "balanced";

    if (!text) {
        return errorResponse("missing_text", "Text is required.", 400);
    }
    if (text.length > 3000) {
        return errorResponse("text_too_long", "Text must not exceed 3000 characters.", 400);
    }
    if (!referenceId) {
        return errorResponse("missing_reference_id", "Fish Audio reference_id is required.", 400);
    }
    if (referenceId.length > 128) {
        return errorResponse("invalid_reference_id", "Fish Audio reference_id is too long.", 400);
    }
    if (!MODEL_PATTERN.test(model)) {
        return errorResponse("invalid_model", "Fish Audio model ID is invalid.", 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);

    try {
        const upstream = await proxyFetch(FISH_TTS_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                model,
            },
            body: JSON.stringify({
                text,
                reference_id: referenceId,
                format: "mp3",
                sample_rate: 44100,
                mp3_bitrate: 128,
                normalize: true,
                latency,
                prosody: {
                    speed: 1,
                    volume: 0,
                    normalize_loudness: true,
                },
            }),
            signal: controller.signal,
        });

        if (!upstream.ok) {
            const detail = (await upstream.text().catch(() => "")).slice(0, 500);
            return errorResponse(
                "fish_tts_failed",
                detail || `Fish Audio request failed (${upstream.status}).`,
                upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
            );
        }

        const audio = await upstream.arrayBuffer();
        if (audio.byteLength === 0) {
            return errorResponse("empty_audio", "Fish Audio returned an empty response.", 502);
        }

        return new Response(audio, {
            status: 200,
            headers: {
                "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
                "Cache-Control": "no-store",
                "Content-Length": String(audio.byteLength),
            },
        });
    } catch (error) {
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        return errorResponse(
            aborted ? "fish_tts_timeout" : "fish_tts_proxy_failed",
            aborted ? "Fish Audio request timed out after 55 seconds." : message.slice(0, 500),
            aborted ? 504 : 502,
        );
    } finally {
        clearTimeout(timer);
    }
}
