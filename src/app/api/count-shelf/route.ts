import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type CatalogueProduct = {
  id: string;
  brand: string;
  product_name: string;
  subcategory: string;
  bottle_size_ml: number | null;
  reference_images: { angle: string; label: string; url: string }[];
};

function unpackImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid camera frame.");
  return { mimeType: match[1], data: match[2] };
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeLabel(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function catalogueKey(brand: string, productName: string) {
  return normalizeLabel(brand) + "|" + normalizeLabel(productName);
}

function safeReferenceUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "images.openfoodfacts.org" ? url.toString() : ""; }
  catch { return ""; }
}

function tokenOverlap(left: unknown, right: unknown) {
  const a = new Set(normalizeLabel(String(left || "")).split(/\s+/).filter(Boolean));
  const b = new Set(normalizeLabel(String(right || "")).split(/\s+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / Math.max(a.size, b.size);
}

async function fetchReferenceImage(url: string) {
  try {
    const response = await fetch(url, { redirect: "error", cache: "force-cache", signal: AbortSignal.timeout(4000) });
    const mimeType = (response.headers.get("content-type") || "").split(";")[0];
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (!response.ok || !/^image\/(jpeg|png|webp)$/i.test(mimeType) || declaredSize > 2_500_000) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2_500_000) return null;
    return { mimeType, data: bytes.toString("base64") };
  } catch { return null; }
}

async function requestShelfModel(parts: any[], key: string, maxOutputTokens: number) {
  let lastError = "AI models are temporarily unavailable.";
  for (const model of ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]) {
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens } }),
      });
      const raw = await response.text();
      if (response.ok) return JSON.parse(raw);
      lastError = raw.slice(0, 200);
      if (![404, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error: any) { lastError = String(error?.message || "Network error"); }
  }
  throw new Error(lastError);
}

export async function POST(req: NextRequest) {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { global: { headers: { Authorization: "Bearer " + token } } },
    );
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return NextResponse.json({ error: "Session expired." }, { status: 401 });
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!member) return NextResponse.json({ error: "No workspace access." }, { status: 403 });

    const body = await req.json();
    const category = body.category;
    if (!["Wine", "Soft Drinks"].includes(category)) return NextResponse.json({ error: "Invalid shelf category." }, { status: 400 });
    const rawFrames = Array.isArray(body.frames) ? body.frames : [body.image];
    if (rawFrames.length < 1 || rawFrames.length > 2 || rawFrames.some((frame: unknown) => typeof frame !== "string")) {
      return NextResponse.json({ error: "Send one or two camera frames." }, { status: 400 });
    }
    const frames = rawFrames.map((frame: string) => unpackImage(frame));
    const catalogue: CatalogueProduct[] = (Array.isArray(body.catalogue) ? body.catalogue : [])
      .slice(0, 80)
      .map((item: any) => ({
        id: cleanText(item?.id, 80),
        brand: cleanText(item?.brand, 80),
        product_name: cleanText(item?.product_name, 120),
        subcategory: cleanText(item?.subcategory, 60),
        bottle_size_ml: Number.isFinite(Number(item?.bottle_size_ml)) && Number(item?.bottle_size_ml) > 0 ? Number(item.bottle_size_ml) : null,
        reference_images: Array.isArray(item?.reference_images) ? item.reference_images.slice(0, 4).flatMap((reference: any) => {
          const url = safeReferenceUrl(reference?.url);
          return url ? [{ angle: cleanText(reference?.angle, 12), label: cleanText(reference?.label, 40), url }] : [];
        }) : [],
      }))
      .filter((item: CatalogueProduct) => item.id && item.product_name);

    const key = process.env.GEMINI_API_KEY;
    if (!key) return NextResponse.json({ error: "Gemini scanner key is not configured." }, { status: 503 });

    const promptCatalogue = catalogue.map(({ reference_images: _references, ...item }) => item);
    const productList = catalogue.length
      ? "Known products in this category (match only when the label supports it): " + JSON.stringify(promptCatalogue) + "\n"
      : "No catalogue products were supplied. Read the visible label without guessing.\n";
    const prompt = `You are counting physical stock during a short camera sweep. These images are consecutive frames in chronological order. Detect each distinct full, closed ${category === "Wine" ? "wine bottle" : "soft drink bottle, can or carton"} visible in any frame. Count identical containers separately when they are physically separate in one frame. If the same physical container appears in multiple frames, report it only once and use the latest frame where it is clearly visible. Ignore opened, partly used or empty containers, spirits, people, shelf labels and posters. ${productList}For each item return catalogue_id when a supplied catalogue entry clearly matches the visible label. Read the printed package volume only when the number is actually legible; return it as observed_size_ml in millilitres, otherwise null. Never infer size from apparent height, width, shape, camera distance or perspective. If multiple catalogue entries have the same brand and product name but different sizes, choose an entry only when its printed volume is legible and exactly agrees with that entry. Otherwise return catalogue_id:null and size_ambiguous:true. If the legible printed volume conflicts with the proposed catalogue entry, return catalogue_id:null and size_mismatch:true. Return JSON only with this shape: {"items":[{"catalogue_id":null,"brand":"...","product_name":"...","subcategory":"...","observed_size_ml":null,"size_ambiguous":false,"size_mismatch":false,"confidence":0.8,"frame_index":0,"box":[left,top,right,bottom]}]}. frame_index is zero-based and box coordinates are normalized integers 0-1000 in that frame. Give every physical container its own box. If none are visible, return an empty items array.`;

    const parts: any[] = [{ text: prompt }];
    frames.forEach((frame: { mimeType: string; data: string }, index: number) => {
      parts.push({ text: `Frame ${index} (${index === 0 ? "earliest" : "latest"}):` });
      parts.push({ inline_data: { mime_type: frame.mimeType, data: frame.data } });
    });

    let payload: any = null;
    let lastStatus = 503;
    let lastError = "AI models are temporarily unavailable.";
    for (const model of ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]) {
      let response: Response;
      try {
        response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 2200 },
          }),
        });
      } catch (e: any) {
        lastStatus = 503;
        lastError = e?.name === "TimeoutError" ? "The image scan timed out on " + model + "." : String(e?.message || "Network error");
        continue;
      }

      const raw = await response.text();
      if (response.ok) {
        try { payload = JSON.parse(raw); break; }
        catch { lastStatus = 502; lastError = "Gemini returned invalid JSON."; continue; }
      }
      lastStatus = response.status;
      lastError = raw.slice(0, 200);
      if (![404, 429, 500, 502, 503, 504].includes(response.status)) {
        return NextResponse.json({ error: "Shelf scanner returned " + response.status + ". " + lastError }, { status: 502 });
      }
      if ([429, 503, 504].includes(response.status)) await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!payload) return NextResponse.json({ error: "All shelf-scanning models are currently unavailable. Last response: " + lastStatus + ". " + lastError }, { status: 503 });
    const text = payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed = JSON.parse(cleaned);
    const rawItems: any[] = Array.isArray(parsed.items) ? parsed.items : [];
    const uncertainItems = rawItems.filter((item: any) => !catalogue.some(product => product.id === cleanText(item?.catalogue_id, 80)) && !item?.size_ambiguous && !item?.size_mismatch);
    if (uncertainItems.length && catalogue.some(product => product.reference_images.length)) {
      const shortlisted: CatalogueProduct[] = [];
      for (const item of uncertainItems.slice(0, 5)) {
        const label = [cleanText(item.brand, 100), cleanText(item.product_name, 140)].filter(Boolean).join(" ");
        if (!label) continue;
        const ranked = catalogue.filter(product => product.reference_images.length)
          .map(product => ({ product, score: tokenOverlap(label, product.brand + " " + product.product_name) }))
          .sort((a, b) => b.score - a.score);
        for (const candidate of ranked.slice(0, 2)) {
          if (candidate.score < 0.08 || shortlisted.some(product => product.id === candidate.product.id)) continue;
          shortlisted.push(candidate.product);
        }
      }
      const referenceParts: any[] = [];
      for (const candidate of shortlisted.slice(0, 4)) {
        for (const reference of candidate.reference_images.slice(0, 2)) {
          const downloaded = await fetchReferenceImage(reference.url);
          if (!downloaded) continue;
          referenceParts.push({ text: `Online reference for catalogue id ${candidate.id}: ${candidate.brand} ${candidate.product_name}, ${reference.label} (${reference.angle}).` });
          referenceParts.push({ inline_data: { mime_type: downloaded.mimeType, data: downloaded.data } });
          if (referenceParts.filter((part: any) => part.inline_data).length >= 8) break;
        }
        if (referenceParts.filter((part: any) => part.inline_data).length >= 8) break;
      }
      if (referenceParts.some((part: any) => part.inline_data)) {
        try {
          const comparisonText = "The first shelf pass left some bottle identities uncertain. Compare the camera frames with the following online reference views. Use references only to match brand and product design; read package sizes and count physical units from the live camera frames only. Do not infer bottle size or quantity from a reference photo. Keep distinct bottles separate and deduplicate the same physical bottle across frames. Return the same JSON shape as requested above.\n";
          const retryPayload = await requestShelfModel([{ text: comparisonText }, ...parts, ...referenceParts], key, 2200);
          const retryText = retryPayload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
          const retryParsed = JSON.parse(retryText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
          const retryItems: any[] = Array.isArray(retryParsed.items) ? retryParsed.items : [];
          const currentMatches = rawItems.filter((item: any) => catalogue.some(product => product.id === cleanText(item?.catalogue_id, 80))).length;
          const retryMatches = retryItems.filter((item: any) => catalogue.some(product => product.id === cleanText(item?.catalogue_id, 80))).length;
          if (retryItems.length && retryMatches >= currentMatches) parsed = retryParsed;
        } catch (retryError: any) {
          console.info("Shelf reference comparison was unavailable", retryError?.message || "retry failed");
        }
      }
    }
    const items = Array.isArray(parsed.items) ? parsed.items.flatMap((item: any) => {
      if (!Array.isArray(item.box) || item.box.length !== 4 || Number(item.confidence) < 0.55) return [];
      const box = item.box.map((value: unknown) => Math.max(0, Math.min(1000, Number(value) || 0)));
      if (box[2] <= box[0] || box[3] <= box[1]) return [];
      const requestedMatch = catalogue.find(product => product.id === cleanText(item.catalogue_id, 80));
      const brand = cleanText(item.brand, 100) || requestedMatch?.brand || "Unknown";
      const productName = cleanText(item.product_name, 140) || requestedMatch?.product_name || "Unknown";
      const identity = requestedMatch ? catalogueKey(requestedMatch.brand, requestedMatch.product_name) : catalogueKey(brand, productName);
      const variants = catalogue.filter(product => catalogueKey(product.brand, product.product_name) === identity);
      const variantSizes = [...new Set(variants.map(product => product.bottle_size_ml).filter((size): size is number => size != null))];
      const rawObservedSize = Number(item.observed_size_ml);
      const observedSize = Number.isFinite(rawObservedSize) && rawObservedSize > 0 ? rawObservedSize : null;
      let match = requestedMatch;
      let sizeMismatch = item.size_mismatch === true;
      if (observedSize && variants.length) {
        const exactSizeMatches = variants.filter(product => product.bottle_size_ml === observedSize);
        if (exactSizeMatches.length === 1) {
          match = exactSizeMatches[0];
          sizeMismatch = false;
        } else if (!exactSizeMatches.length) {
          match = null;
          sizeMismatch = true;
        }
      }
      const sizeAmbiguous = item.size_ambiguous === true || (variantSizes.length > 1 && !observedSize);
      if (sizeMismatch || sizeAmbiguous) match = null;
      const size = match?.bottle_size_ml ?? observedSize;
      return [{
        catalogue_id: match?.id || null,
        brand: match?.brand || brand,
        product_name: match?.product_name || productName,
        subcategory: match?.subcategory || cleanText(item.subcategory, 80),
        bottle_size_ml: Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : null,
        observed_size_ml: observedSize,
        size_ambiguous: sizeAmbiguous,
        size_mismatch: sizeMismatch,
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        frame_index: Math.max(0, Math.min(frames.length - 1, Math.floor(Number(item.frame_index) || 0))),
        box,
      }];
    }) : [];
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("Shelf scan failed", e);
    return NextResponse.json({ error: e?.message || "Shelf scan failed." }, { status: 500 });
  }
}

