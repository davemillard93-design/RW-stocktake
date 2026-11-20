import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type ImageReference = {
  angle: "front" | "back" | "other";
  label: string;
  url: string;
  source: "Open Food Facts";
  sourceUrl: string;
};

function imageUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim(), "https://images.openfoodfacts.org");
    return url.protocol === "https:" && url.hostname === "images.openfoodfacts.org" ? url.toString() : "";
  } catch { return ""; }
}

function productImageFolder(barcode: string) {
  const normalized = barcode.length < 13 ? barcode.padStart(13, "0") : barcode;
  return [normalized.slice(0, 3), normalized.slice(3, 6), normalized.slice(6, 9), normalized.slice(9)].join("/");
}

function preferredLanguageImages(value: any): string[] {
  if (typeof value === "string") return [imageUrl(value)].filter(Boolean);
  if (!value || typeof value !== "object") return [];
  const find = (entry: any): string => {
    if (typeof entry === "string") return imageUrl(entry);
    if (!entry || typeof entry !== "object") return "";
    for (const key of ["en", "display", "zoom", "small", "thumb"]) {
      const result = find(entry[key]);
      if (result) return result;
    }
    for (const child of Object.values(entry)) {
      const result = find(child);
      if (result) return result;
    }
    return "";
  };
  const result = find(value);
  return result ? [result] : [];
}

function labelForImage(key: string): { angle: ImageReference["angle"]; label: string } {
  const type = key.toLowerCase().split("_")[0];
  if (type === "front") return { angle: "front", label: "Front label" };
  if (type === "ingredients") return { angle: "back", label: "Ingredients / back label" };
  if (type === "nutrition") return { angle: "back", label: "Nutrition / back label" };
  if (type === "other") return { angle: "other", label: "Other view" };
  return { angle: "other", label: "Packaging detail" };
}

function collectImageReferences(product: any, barcode: string): ImageReference[] {
  const sourceUrl = "https://world.openfoodfacts.org/product/" + barcode;
  const folder = productImageFolder(barcode);
  const images = product?.images && typeof product.images === "object" ? product.images : {};
  const selectedIds = new Set<string>();
  const refs: ImageReference[] = [];
  const add = (key: string, url: string) => {
    const safeUrl = imageUrl(url);
    if (!safeUrl || refs.some(ref => ref.url === safeUrl) || refs.length >= 8) return;
    const { angle, label } = labelForImage(key);
    refs.push({ angle, label, url: safeUrl, source: "Open Food Facts", sourceUrl });
  };

  for (const [key, metadata] of Object.entries(images)) {
    if (!/^(front|ingredients|nutrition|packaging|other)(?:_[a-z]{2})?$/i.test(key)) continue;
    const entry = metadata as any;
    if (entry?.imgid != null) selectedIds.add(String(entry.imgid));
    const revision = Number(entry?.rev);
    const languageKey = /_[a-z]{2}$/i.test(key) ? key : key + "_en";
    const direct = entry?.sizes?.["400"]?.url || entry?.sizes?.full?.url;
    const url = Number.isFinite(revision) && revision > 0
      ? `https://images.openfoodfacts.org/images/products/${folder}/${languageKey}.${revision}.400.jpg`
      : imageUrl(direct);
    add(key, url);
  }

  const selected = product?.selected_images && typeof product.selected_images === "object" ? product.selected_images : {};
  for (const key of ["front", "ingredients", "nutrition", "other", "packaging"]) {
    const variants = selected[key];
    if (!variants || typeof variants !== "object") continue;
    const preferred = variants.en || variants[Object.keys(variants)[0]];
    const urls = preferredLanguageImages(preferred);
    if (urls.length) add(key, urls[0]);
  }

  for (const [key, metadata] of Object.entries(images)) {
    if (!/^\d+$/.test(key) || selectedIds.has(key)) continue;
    add("other", `https://images.openfoodfacts.org/images/products/${folder}/${key}.400.jpg`);
  }
  return refs;
}

export async function GET(request: NextRequest) {
  const barcode = (request.nextUrl.searchParams.get("barcode") || "").trim();
  if (!/^\d{6,14}$/.test(barcode)) return NextResponse.json({ error: "Enter a valid product barcode." }, { status: 400 });

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { global: { headers: { Authorization: "Bearer " + token } } },
    );
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return NextResponse.json({ error: "Your session has expired. Please sign in again." }, { status: 401 });
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!member) return NextResponse.json({ error: "No workspace access." }, { status: 403 });

    const response = await fetch(
      "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(barcode) + ".json?fields=code,product_name,brands,images,selected_images",
      {
        headers: { "User-Agent": "PourVentory/1.0 (https://pourventory.vercel.app; bottle reference photos)", "Accept-Language": "en" },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) return NextResponse.json({ error: "Open Food Facts photo lookup is temporarily unavailable." }, { status: 503 });

    const payload: any = await response.json();
    const product = payload?.product;
    if (Number(payload?.status) !== 1 || !product) return NextResponse.json({ barcode, images: [] });
    const images = collectImageReferences(product, barcode);
    return NextResponse.json({
      barcode,
      productName: String(product.product_name || "").slice(0, 140),
      brand: String(product.brands || "").slice(0, 100),
      productUrl: "https://world.openfoodfacts.org/product/" + barcode,
      images,
    });
  } catch (error: any) {
    console.error("Product image lookup failed", error?.message || error);
    return NextResponse.json({ error: "Could not retrieve bottle photos right now." }, { status: 503 });
  }
}

