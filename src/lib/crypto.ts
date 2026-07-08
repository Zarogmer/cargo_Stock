// Criptografia simétrica pra credenciais em repouso (tokens do Graph,
// certificados bancários) — módulo Financeiro/Contas a Pagar.
//
// AES-256-GCM com IV aleatório por mensagem. Formato do texto cifrado:
//   "v1:<iv base64>:<authTag base64>:<ciphertext base64>"
// O prefixo "v1:" permite trocar de algoritmo/chave no futuro sem quebrar o
// que já está gravado.
//
// A chave vem de FINANCE_ENCRYPTION_KEY (32 bytes em base64 — gerar com
// `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
// Sem a env configurada, encryptSecret/decryptSecret lançam erro — nunca
// gravamos segredo em texto puro como fallback.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // recomendado pra GCM

function getKey(): Buffer {
  const raw = process.env.FINANCE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "FINANCE_ENCRYPTION_KEY não configurada — necessária pra criptografar credenciais do Financeiro"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FINANCE_ENCRYPTION_KEY inválida — precisa ter 32 bytes em base64");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Texto cifrado em formato desconhecido");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
