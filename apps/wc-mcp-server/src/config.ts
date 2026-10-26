function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  woocommerce: {
    baseUrl: required("WOOCOMMERCE_URL"),
    oauthBaseUrl: process.env.WOOCOMMERCE_OAUTH_BASE_URL ?? required("WOOCOMMERCE_URL"),
    consumerKey: required("WOOCOMMERCE_CONSUMER_KEY"),
    consumerSecret: required("WOOCOMMERCE_CONSUMER_SECRET"),
    timeoutMs: Number(process.env.WOOCOMMERCE_TIMEOUT_MS ?? 15000),
  },
};
