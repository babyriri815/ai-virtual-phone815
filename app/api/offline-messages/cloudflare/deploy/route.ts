import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { cloudflareApi, cloudflareErrorResponse } from "@/lib/offline-messages/cloudflare-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DeployBody = {
    token?: string;
    accountId?: string;
    scriptName?: string;
    subdomain?: string;
    contactEmail?: string;
};

type D1Database = { uuid?: string; id?: string; name?: string };
type WorkerScript = { id?: string; tag?: string };

function toBase64Url(input: Buffer | string): string {
    return Buffer.from(input).toString("base64url");
}

function generateVapidKeys(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pub = publicKey.export({ format: "jwk" });
    const priv = privateKey.export({ format: "jwk" });
    if (!pub.x || !pub.y || !priv.d) throw new Error("无法产生 VAPID 金钥");
    const rawPublic = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(pub.x, "base64url"),
        Buffer.from(pub.y, "base64url"),
    ]);
    return { publicKey: toBase64Url(rawPublic), privateKey: priv.d };
}

function normalizeName(value: string | undefined, fallback: string): string {
    const clean = (value || fallback).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(clean)) {
        throw new Error("Worker 名称只能使用小写英文、数字与连字号，长度 4–63 字。 ");
    }
    return clean;
}

async function ensureSubdomain(token: string, accountId: string, desired?: string): Promise<string> {
    const current = await cloudflareApi<{ subdomain?: string }>(token, `/accounts/${accountId}/workers/subdomain`);
    if (current?.subdomain) return current.subdomain;
    const next = desired?.trim().toLowerCase();
    if (!next) throw new Error("这个 Cloudflare 帐号还没有 workers.dev 子网域，请填一个想使用的名称。 ");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(next)) {
        throw new Error("workers.dev 子网域格式不正确。 ");
    }
    const result = await cloudflareApi<{ subdomain?: string }>(token, `/accounts/${accountId}/workers/subdomain`, {
        method: "PUT",
        body: JSON.stringify({ subdomain: next }),
    });
    return result?.subdomain || next;
}

async function ensureDatabase(token: string, accountId: string, name: string): Promise<{ id: string; reused: boolean }> {
    const existing = await cloudflareApi<D1Database[]>(token, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`);
    const hit = existing.find((item) => item.name === name && (item.uuid || item.id));
    if (hit) return { id: String(hit.uuid || hit.id), reused: true };
    const created = await cloudflareApi<D1Database>(token, `/accounts/${accountId}/d1/database`, {
        method: "POST",
        body: JSON.stringify({ name }),
    });
    const id = created.uuid || created.id;
    if (!id) throw new Error("Cloudflare 没有返回 D1 database id。 ");
    return { id, reused: false };
}

async function initializeWorker(workerUrl: string, serverToken: string): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 850));
        try {
            const response = await fetch(`${workerUrl}/init-tenant`, {
                method: "POST",
                headers: { "X-Client-Token": serverToken },
            });
            if (response.ok) return;
            lastError = `HTTP ${response.status}: ${await response.text()}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`Worker 已上传，但初始化失败：${lastError}`);
}

export async function POST(request: Request) {
    try {
        const body = await request.json() as DeployBody;
        const token = body.token?.trim();
        const accountId = body.accountId?.trim();
        if (!token || token.length < 20 || !accountId) {
            return Response.json({ ok: false, error: "缺少 Cloudflare Token 或帐号。" }, { status: 400 });
        }

        const suffix = createHash("sha256").update(accountId).digest("hex").slice(0, 6);
        const scriptName = normalizeName(body.scriptName, `float-amsg-${suffix}`);
        const databaseName = `${scriptName}-db`;
        const contactEmail = body.contactEmail?.trim() || "float@example.invalid";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
            return Response.json({ ok: false, error: "VAPID 联络信箱格式不正确。" }, { status: 400 });
        }

        const scripts = await cloudflareApi<WorkerScript[]>(token, `/accounts/${accountId}/workers/scripts`);
        if (scripts.some((item) => item.id === scriptName)) {
            return Response.json({
                ok: false,
                error: `Cloudflare 已经有名为 ${scriptName} 的 Worker。为避免覆盖旧金钥，请换一个名称。`,
                code: "WORKER_EXISTS",
            }, { status: 409 });
        }

        const subdomain = await ensureSubdomain(token, accountId, body.subdomain);
        const database = await ensureDatabase(token, accountId, databaseName);
        const origin = new URL(request.url).origin;
        const bundleResponse = await fetch(`${origin}/float-amsg-cloudflare-worker.js`, { cache: "no-store" });
        if (!bundleResponse.ok) throw new Error(`读取 Worker 程式失败（HTTP ${bundleResponse.status}）`);
        const workerCode = await bundleResponse.text();
        if (workerCode.length < 20_000) throw new Error("Worker 程式不完整，请先重新部署 Float。 ");

        const masterKey = randomBytes(32).toString("hex");
        const serverToken = toBase64Url(randomBytes(32));
        const vapid = generateVapidKeys();
        const metadata = {
            main_module: "worker.js",
            compatibility_date: "2025-04-01",
            bindings: [
                { type: "d1", name: "DB", database_id: database.id },
                { type: "plain_text", name: "FLOAT_ALLOWED_ORIGIN", text: origin },
                { type: "secret_text", name: "AMSG_MASTER_KEY", text: masterKey },
                { type: "secret_text", name: "AMSG_SERVER_TOKEN", text: serverToken },
                { type: "secret_text", name: "VAPID_EMAIL", text: `mailto:${contactEmail}` },
                { type: "secret_text", name: "VAPID_PUBLIC_KEY", text: vapid.publicKey },
                { type: "secret_text", name: "VAPID_PRIVATE_KEY", text: vapid.privateKey },
            ],
            observability: { enabled: true, logs: { enabled: true } },
        };
        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        form.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");

        await cloudflareApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
            method: "PUT",
            body: form,
        });
        await cloudflareApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`, {
            method: "PUT",
            body: JSON.stringify([{ cron: "* * * * *" }]),
        });
        await cloudflareApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`, {
            method: "POST",
            body: JSON.stringify({ enabled: true, previews_enabled: false }),
        });

        const workerUrl = `https://${scriptName}.${subdomain}.workers.dev`;
        await initializeWorker(workerUrl, serverToken);
        return Response.json({
            ok: true,
            workerUrl,
            serverToken,
            accountId,
            scriptName,
            databaseId: database.id,
            reusedDatabase: database.reused,
        });
    } catch (error) {
        return cloudflareErrorResponse(error);
    }
}
