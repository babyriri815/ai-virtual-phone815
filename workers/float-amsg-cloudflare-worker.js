import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush,
} from "@rei-standard/amsg-server/cloudflare";

export default createSingleUserCloudflareWorker((env) => ({
  masterKey: env.AMSG_MASTER_KEY,
  serverToken: env.AMSG_SERVER_TOKEN,
  cors: {
    origin: env.FLOAT_ALLOWED_ORIGIN,
  },
  vapid: {
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  },
  webpush: createWebCryptoWebPush({
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  }),
}));
