type CloudflareEnvelope<T> = {
    success: boolean;
    result?: T;
    errors?: Array<{ code?: number; message?: string }>;
    messages?: Array<{ code?: number; message?: string }>;
};

const API_ROOT = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
    status: number;
    code?: number;

    constructor(message: string, status: number, code?: number) {
        super(message);
        this.name = "CloudflareApiError";
        this.status = status;
        this.code = code;
    }
}

export async function cloudflareApi<T>(
    token: string,
    path: string,
    init: RequestInit = {},
): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${API_ROOT}${path}`, { ...init, headers, cache: "no-store" });
    const payload = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
    if (!response.ok || !payload?.success) {
        const first = payload?.errors?.[0] ?? payload?.messages?.[0];
        const detail = first?.message || `HTTP ${response.status}`;
        throw new CloudflareApiError(`Cloudflare 请求失败：${detail}`, response.status, first?.code);
    }
    return payload.result as T;
}

export function cloudflareErrorResponse(error: unknown): Response {
    if (error instanceof CloudflareApiError) {
        const hint = error.status === 401 || error.status === 403
            ? "请确认 Token 包含 Account Settings: Read、Workers Scripts: Edit、D1: Edit 权限。"
            : undefined;
        return Response.json({ ok: false, error: error.message, hint }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message || "未知错误" }, { status: 500 });
}
