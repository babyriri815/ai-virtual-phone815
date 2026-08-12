import { cloudflareApi, cloudflareErrorResponse } from "@/lib/offline-messages/cloudflare-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Account = { id: string; name: string };

export async function POST(request: Request) {
    try {
        const body = await request.json() as { token?: string };
        const token = body.token?.trim();
        if (!token || token.length < 20) {
            return Response.json({ ok: false, error: "请贴上完整的 Cloudflare API Token。" }, { status: 400 });
        }
        const accounts = await cloudflareApi<Account[]>(token, "/accounts?per_page=50");
        return Response.json({
            ok: true,
            accounts: accounts.map(({ id, name }) => ({ id, name })),
        });
    } catch (error) {
        return cloudflareErrorResponse(error);
    }
}
