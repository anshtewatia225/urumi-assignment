import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface GeneratedApiKey {
  plaintext: string;
  hash: string;
  prefix: string;
  last4: string;
}

export function generateApiKey(): GeneratedApiKey {
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `gw_${id}_${secret}`;
  return {
    plaintext,
    hash: sha256(plaintext),
    prefix: plaintext.slice(0, 12),
    last4: plaintext.slice(-4),
  };
}

export function generatePassword(length = 24): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

const SCRYPT_PREFIX = "scrypt";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${SCRYPT_PREFIX}:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split(":");
  if (scheme !== SCRYPT_PREFIX || !saltB64 || !hashB64) {
    return false;
  }
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  decrypt(value: string): string {
    const [version, ivB64, tagB64, dataB64] = value.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
      throw new Error("Invalid encrypted credential payload");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }
}
