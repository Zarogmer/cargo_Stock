import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { prisma } from "@/lib/prisma";

// Fotos dos Relatórios de Bordo no Bucket do Railway (S3 privado, "fotos-
// relatorios"). Até set/2026 a foto vivia inline no Postgres como data URL e
// o volume de 500 MB encheu em semanas; agora o banco guarda só a chave do
// objeto e os bytes ficam no bucket (US$ 0,015/GB, egress grátis).
//
// O bucket é privado: a foto continua sendo servida pelo nosso backend
// (GET /api/relatorios/fotos/[id]), que checa a permissão do navio antes de
// buscar o objeto. Sem as variáveis PHOTO_BUCKET_* (dev local sem bucket) a
// foto cai no formato antigo, inline — nunca deixa de subir.
//
// Variáveis (no Railway são referências ao bucket: ${{fotos-relatorios.BUCKET}}
// etc.): PHOTO_BUCKET, PHOTO_BUCKET_ENDPOINT, PHOTO_BUCKET_REGION,
// PHOTO_BUCKET_ACCESS_KEY_ID, PHOTO_BUCKET_SECRET_ACCESS_KEY.

type BucketConfig = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function readConfig(): BucketConfig | null {
  const bucket = process.env.PHOTO_BUCKET;
  const endpoint = process.env.PHOTO_BUCKET_ENDPOINT;
  const accessKeyId = process.env.PHOTO_BUCKET_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PHOTO_BUCKET_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, region: process.env.PHOTO_BUCKET_REGION || "auto", accessKeyId, secretAccessKey };
}

let cached: { config: BucketConfig; client: S3Client } | null | undefined;

function s3(): { config: BucketConfig; client: S3Client } | null {
  if (cached !== undefined) return cached;
  const config = readConfig();
  if (!config) {
    cached = null;
    return null;
  }
  cached = {
    config,
    client: new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }),
  };
  return cached;
}

export function photoBucketConfigured(): boolean {
  return s3() !== null;
}

// Chave do objeto: uma "pasta" por relatório, nome = id da foto no banco. O id
// já é único e a pasta deixa o bucket navegável no explorador do Railway.
export function photoStorageKey(reportId: string, photoId: number, mime: string): string {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return `relatorios/${reportId}/${photoId}.${ext}`;
}

// data URL (data:image/jpeg;base64,...) → bytes + mime. O regex casa só o
// prefixo: o base64 em si pode ter megabytes e não precisa ser validado por
// regex.
export type PhotoBytes = { mime: string; bytes: Buffer<ArrayBuffer> };

export function parseImageDataUrl(dataUrl: string): PhotoBytes | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  const m = head.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64$/);
  if (!m) return null;
  const mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  return { mime, bytes: Buffer.from(dataUrl.slice(comma + 1), "base64") };
}

export async function putPhotoObject(key: string, bytes: Buffer, mime: string): Promise<void> {
  const conn = s3();
  if (!conn) throw new Error("Bucket de fotos não configurado");
  await conn.client.send(
    new PutObjectCommand({ Bucket: conn.config.bucket, Key: key, Body: bytes, ContentType: mime })
  );
}

export async function getPhotoObject(key: string): Promise<Buffer<ArrayBuffer> | null> {
  const conn = s3();
  if (!conn) return null;
  try {
    const res = await conn.client.send(new GetObjectCommand({ Bucket: conn.config.bucket, Key: key }));
    if (!res.Body) return null;
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

// Apagar objeto é "melhor esforço": a linha no banco já foi embora, e um
// objeto órfão custa centavos — não vale derrubar a operação do usuário.
export async function deletePhotoObjects(keys: (string | null | undefined)[]): Promise<void> {
  const conn = s3();
  const list = keys.filter((k): k is string => Boolean(k));
  if (!conn || !list.length) return;
  try {
    if (list.length === 1) {
      await conn.client.send(new DeleteObjectCommand({ Bucket: conn.config.bucket, Key: list[0] }));
      return;
    }
    // DeleteObjects aceita até 1000 chaves por chamada.
    for (let i = 0; i < list.length; i += 1000) {
      await conn.client.send(
        new DeleteObjectsCommand({
          Bucket: conn.config.bucket,
          Delete: { Objects: list.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        })
      );
    }
  } catch (err) {
    console.error("[photo-storage] falha ao apagar objeto(s) do bucket:", err);
  }
}

// Bytes de uma foto, venha ela do bucket (storage_key) ou do formato antigo
// inline (image_data). null = foto sem imagem (objeto sumiu ou dado corrompido).
export async function loadPhotoBytes(photo: {
  storage_key: string | null;
  image_data: string | null;
  mime_type: string;
}): Promise<PhotoBytes | null> {
  if (photo.storage_key) {
    const bytes = await getPhotoObject(photo.storage_key);
    return bytes ? { mime: photo.mime_type || "image/jpeg", bytes } : null;
  }
  if (photo.image_data) return parseImageDataUrl(photo.image_data);
  return null;
}

// Antes de apagar navio/relatório pelo /api/db (cascade leva as linhas das
// fotos junto), recolhe as chaves pra limpar o bucket depois do delete.
export async function photoKeysForJobs(jobIds: string[]): Promise<string[]> {
  if (!jobIds.length || !photoBucketConfigured()) return [];
  const rows = await prisma.shipReportPhoto.findMany({
    where: { reports: { job_id: { in: jobIds } }, storage_key: { not: null } },
    select: { storage_key: true },
  });
  return rows.map((r) => r.storage_key!).filter(Boolean);
}
