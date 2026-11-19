import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function unpackImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("The camera image could not be read. Please scan again.");
  return { mimeType: match[1], data: match[2] };
}

function parseModelJson(value: string) {
  const cleaned = value.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "");
  return JSON.parse(cleaned);
}

export async function POST(req: NextRequest) {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: "Stocktake database connection is not configured." }, { status: 503 });
    }
    const sb = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: "Bearer " + token } },
    });
    const { data: auth, error: authError } = await sb.auth.getUser(token);
    if (authError || !auth.user) {
      return NextResponse.json({ error: "Your session has expired. Please sign in again." }, { status: 401 });
    }
    const { data: member, error: memberError } = await sb
      .from("workspace_members").select("workspace_id").eq("user_id", auth.user.id).limit(1).maybeSingle();
    if (memberError || !member) {
      return NextResponse.json({ error: "No workspace access." }, { status: 403 });
    }

    const body = await req.json();
    if (typeof body.image !== "string" || !body.image.startsWith("data:image/")) {
      return NextResponse.json({ error: "Capture a clear bottle image first." }, { status: 400 });
    }
    if (!Array.isArray(body.catalogue) || body.catalogue.length === 0) {
      return NextResponse.json({ error: "Your spirits catalogue is empty." }, { status: 400 });
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) return NextResponse.json({ error: "Gemini scanner key is not configured." }, { status: 503 });

    const image = unpackImage(body.image);
    const catalogue = body.catalogue.slice(0, 250).map((item: any) => ({
      id: String(item.id),
      brand: String(item.brand || ""),
      product_name: String(item.product_name || ""),
      spirit_type: String(item.spirit_type || ""),
      bottle_size_ml: Number(item.bottle_size_ml) || 700,
    }));

    const prompt = [
      "You are measuring the liquid level in a spirits bottle for a bar stocktake. Be a measuring instrument, not a general visual guesser.",
      "TASK 1 — PRODUCT: Read the printed brand and product label, then select the matching catalogue id. The brand and product_name fields may split the full name across both fields. Example: brand 'Bulleit Bourbon' plus product_name 'Bourbon' is one Bulleit Bourbon product. Select only an exact supplied id.",
      "TASK 2 — MEASURE THE LIQUID: Ignore the label artwork and label height. Find the actual horizontal boundary between liquid and air inside the bottle. Use the visible liquid surface/meniscus, not reflections, glass colour, label edges, shadows or bottle embossing.",
      "Define the usable fill height as the inside bottom of the bottle (0%) to the normal full-fill point at the base of the neck/shoulder transition (100%). Do not include the narrow neck above that point. Follow the bottle's visible internal shape.",
      "Imagine this usable height divided into TEN equal vertical intervals. Locate the liquid boundary relative to those ten divisions. Count how many tenths are filled from the bottom. Choose the nearest whole tenth: 0,1,2,3,4,5,6,7,8,9,10. Do not output a free-form percentage.",
      "Return fill_tenths as an integer from 0 to 10. The server will convert it to percent by multiplying by 10. Example: fill_tenths 7 means 70%.",
      "If the bottle is tilted, heavily obscured, opaque, or the liquid boundary cannot be distinguished from reflections, set needs_review true. Still give your best estimate only if a boundary is visible. Confidence must reflect how clearly the liquid boundary is visible, not how well you read the label.",
      "Return JSON only with keys: product_id, fill_tenths, confidence, needs_review, notes. No markdown and no additional keys.",
      "Catalogue: " + JSON.stringify(catalogue),
    ].join("\n");

    // If the primary Gemini model is overloaded, automatically fall back to
    // the lighter multimodal model rather than failing the stocktake scan.
    let response: Response | null = null;
    let raw = "";
    let lastModel = "";
    for (const model of ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]) {
      lastModel = model;
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: image.mimeType, data: image.data } }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 400 },
          }),
        }
      );
      raw = await response.text();
      if (response.ok) break;
      if (![404, 429, 500, 502, 503, 504].includes(response.status)) break;
      console.warn("Gemini model unavailable; trying next model", model, response.status, raw.slice(0, 300));
    }
    if (!response) throw new Error("The recognition service could not be reached.");
    if (!response.ok) {
      console.error("Gemini bottle scan failed", response.status, raw.slice(0, 1200));
      return NextResponse.json(
        { error: "Bottle recognition service returned an error (" + response.status + "). Please try again in better light." },
        { status: 502 }
      );
    }

    let parsed: any;
    try {
      const payload = JSON.parse(raw);
      const modelText = payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
      if (!modelText) throw new Error("The recognition service returned no result.");
      parsed = parseModelJson(modelText);
    } catch (error: any) {
      console.error("Could not parse bottle scan response", error?.message, raw.slice(0, 1200));
      return NextResponse.json({ error: "I couldn't read the bottle scan result. Hold the bottle steady and try again." }, { status: 502 });
    }

    let match = catalogue.find((item: any) => item.id === String(parsed.product_id || ""));
    if (!match && parsed.brand_or_product) {
      const guess = String(parsed.brand_or_product).toLowerCase();
      match = catalogue.find((item: any) => (item.brand + " " + item.product_name).toLowerCase().includes(guess));
    }
    if (!match) {
      return NextResponse.json({
        error: parsed.notes || "I couldn't confidently read the bottle label. Move closer so the brand name is clear, then scan again.",
        detection: { product_id: "", notes: parsed.notes || "Bottle not matched to catalogue." },
      }, { status: 422 });
    }

    const rawTenths = Number(parsed.fill_tenths);
    if (!Number.isFinite(rawTenths) || rawTenths < 0 || rawTenths > 10) {
      return NextResponse.json({ error: "I recognised the bottle but couldn't locate the liquid boundary clearly enough to measure it. Hold the bottle upright with the liquid line visible and scan again." }, { status: 422 });
    }
    // Convert the model's measured tenth directly to a 10% stocktake value.
    const fill = Math.round(rawTenths) * 10;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return NextResponse.json({
      detection: {
        product_id: match.id,
        fill_percentage: fill,
        confidence,
        needs_review: Boolean(parsed.needs_review) || confidence < 0.55,
        notes: String(parsed.notes || "AI estimate. Check the liquid line before recording."),
      },
    });
  } catch (error: any) {
    console.error("Bottle scan error", error);
    return NextResponse.json({ error: error?.message || "Bottle scan failed. Please try again." }, { status: 500 });
  }
}
