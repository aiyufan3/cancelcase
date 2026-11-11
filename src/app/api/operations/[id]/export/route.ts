import { envelope, jsonError, requireRole } from "@/server/http/guards";
import { AppError } from "@/server/services/errors";
import { readExportDownload, type ExportSelector } from "@/server/services/export-download";

export const dynamic = "force-dynamic";

/**
 * Recipient download for one approved export: `?file=message|pack-md|pack-json` or
 * `?attachment=<evidence id>`. Serves only what that export recorded, checked against the
 * hashes recorded then. Writes an audit entry; sends nothing anywhere. The private local
 * archive is a separate download.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const env = envelope(req);
    const role = requireRole(env);
    const { id } = await params;
    const query = new URL(req.url).searchParams;
    const file = query.get("file");
    const attachment = query.get("attachment");
    if ((file === null) === (attachment === null))
      throw new AppError("EXPORT_ITEM_REQUIRED", "Name exactly one item: file or attachment.", 400);
    const selector: ExportSelector = file !== null ? { file } : { attachment: attachment! };
    const download = readExportDownload(env.ctx, role, id, selector);
    const text = download.mime === "text/markdown" || download.mime === "application/json";
    return new Response(new Uint8Array(download.bytes), {
      headers: {
        "Content-Type": text ? `${download.mime}; charset=utf-8` : download.mime,
        "Content-Length": String(download.bytes.length),
        "Content-Disposition": `attachment; filename="${download.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
