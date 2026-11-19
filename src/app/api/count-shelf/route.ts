import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type CatalogueProduct = {
  id: string;
  brand: string;
  product_name: string;
  subcategory: string;
  bottle_size_ml: number | null;
};

function unpackImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid camera frame.");
  return { mimeType: match[1], data: match[2] };
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
      }))
      .filter((item: CatalogueProduct) => item.id && item.product_name);

    const key = process.env.GEMINI_API_KEY;
    if (!key) return NextResponse.json({ error: "Gemini scanner key is not configured." }, { status: 503 });

    const productList = catalogue.length
      ? "Known products in this category (match only when the label supports it): " + JSON.stringify(catalogue) + "\n"
      : "No catalogue products were supplied. Read the visible label without guessing.\n";
    const prompt = `You are counting physical stock during a short camera sweep. These images are consecutive frames in chronological order. Detect each distinct full, closed ${category === "Wine" ? "wine bottle" : "soft drink bottle, can or carton"} visible in any frame. Count identical containers separately when they are physically separate in one frame. If the same physical container appears in multiple frames, report it only once and use the latest frame where it is clearly visible. Ignore opened, partly used or empty containers, spirits, people, shelf labels and posters. ${productList}For each item return catalogue_id when a supplied catalogue entry clearly matches the visible label; otherwise return null and read brand and product_name only when legible, using "Unknown" when not readable. Return JSON only with this shape: {"items":[{"catalogue_id":null,"brand":"...","product_name":"...","subcategory":"...","bottle_size_ml":null,"confidence":0.8,"frame_index":0,"box":[left,top,right,bottom]}]}. frame_index is zero-based and box coordinates are normalized integers 0-1000 in that frame. Give every physical container its own box. If none are visible, return an empty items array.`;

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
    const parsed = JSON.parse(cleaned);
    const items = Array.isArray(parsed.items) ? parsed.items.flatMap((item: any) => {
      if (!Array.isArray(item.box) || item.box.length !== 4 || Number(item.confidence) < 0.55) return [];
      const box = item.box.map((value: unknown) => Math.max(0, Math.min(1000, Number(value) || 0)));
      if (box[2] <= box[0] || box[3] <= box[1]) return [];
      const match = catalogue.find(product => product.id === cleanText(item.catalogue_id, 80));
      const size = match?.bottle_size_ml ?? (Number(item.bottle_size_ml) || null);
      return [{
        catalogue_id: match?.id || null,
        brand: match?.brand || cleanText(item.brand, 100) || "Unknown",
        product_name: match?.product_name || cleanText(item.product_name, 140) || "Unknown",
        subcategory: match?.subcategory || cleanText(item.subcategory, 80),
        bottle_size_ml: Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : null,
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

