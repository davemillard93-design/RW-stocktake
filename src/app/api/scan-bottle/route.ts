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

function safeReferenceUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "images.openfoodfacts.org" ? url.toString() : "";
  } catch { return ""; }
}

function tokenOverlap(left: unknown, right: unknown) {
  const words = (value: unknown) => new Set(String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const a = words(left), b = words(right);
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

async function requestModelJson(parts: any[], key: string, maxOutputTokens: number) {
  let lastError = "The recognition service could not be reached.";
  for (const model of ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]) {
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens } }),
      });
      const raw = await response.text();
      if (!response.ok) {
        lastError = raw.slice(0, 200);
        if (![404, 429, 500, 502, 503, 504].includes(response.status)) break;
        continue;
      }
      const payload = JSON.parse(raw);
      const text = payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
      if (!text) throw new Error("The recognition service returned no result.");
      return parseModelJson(text);
    } catch (error: any) {
      lastError = error?.name === "TimeoutError" ? "Bottle recognition timed out." : String(error?.message || "Bottle recognition failed.");
    }
  }
  throw new Error(lastError);
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
      reference_images: Array.isArray(item.reference_images) ? item.reference_images.slice(0, 8).flatMap((reference: any) => {
        const url = safeReferenceUrl(reference?.url);
        return url ? [{ angle: String(reference?.angle || "other").slice(0, 12), label: String(reference?.label || "Bottle view").slice(0, 40), url }] : [];
      }) : [],
    }));
    const promptCatalogue = catalogue.map(({ reference_images: _references, ...item }: any) => item);

    const prompt = [
      "You are measuring the liquid level in a spirits bottle for a bar stocktake. Be a measuring instrument, not a general visual guesser.",
      "TASK 1 — PRODUCT: Read the printed brand and product label, then select the matching catalogue id. The brand and product_name fields may split the full name across both fields. Example: brand 'Bulleit Bourbon' plus product_name 'Bourbon' is one Bulleit Bourbon product. Select only an exact supplied id. If unsure, return an empty product_id and put visible brand/product text in visible_label. Return product_confidence from 0 to 1 for the identity match.",
      "TASK 2 — MEASURE THE LIQUID: Ignore the label artwork and label height. Find the actual horizontal boundary between liquid and air inside the bottle. Use the visible liquid surface/meniscus, not reflections, glass colour, label edges, shadows or bottle embossing.",
      "Define the usable fill height as the inside bottom of the bottle (0%) to the normal full-fill point at the base of the neck/shoulder transition (100%). Do not include the narrow neck above that point. Follow the bottle's visible internal shape.",
      "Imagine this usable height divided into TEN equal vertical intervals. Locate the liquid boundary relative to those ten divisions. Count how many tenths are filled from the bottom. Choose the nearest whole tenth: 0,1,2,3,4,5,6,7,8,9,10. Do not output a free-form percentage.",
      "Return fill_tenths as an integer from 0 to 10. The server will convert it to percent by multiplying by 10. Example: fill_tenths 7 means 70%.",
      "If the bottle is tilted, heavily obscured, opaque, or the liquid boundary cannot be distinguished from reflections, set needs_review true. Still give your best estimate only if a boundary is visible. Confidence must reflect how clearly the liquid boundary is visible, not how well you read the label.",
      "Return JSON only with keys: product_id, product_confidence, visible_label, fill_tenths, confidence, needs_review, notes. No markdown and no additional keys.",
      "Catalogue: " + JSON.stringify(promptCatalogue),
    ].join("\n");

    // If the primary Gemini model is overloaded, automatically fall back to
    // the lighter multimodal model rather than failing the stocktake scan.
    let response: Response | null = null;
    let raw = "";
    let lastModel = "";
    let lastStatus = 503;
    let lastError = "The recognition service could not be reached.";
    for (const model of ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]) {
      lastModel = model;
      try {
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
      } catch (error: any) {
        response = null;
        lastStatus = 503;
        lastError = error?.name === "TimeoutError" ? "Bottle recognition timed out on " + model + "." : "Bottle recognition could not reach " + model + ".";
        console.warn("Gemini bottle scan request failed; trying next model", model, error?.name || "NetworkError");
        continue;
      }
      if (response.ok) break;
      lastStatus = response.status;
      lastError = raw.slice(0, 200);
      if (![404, 429, 500, 502, 503, 504].includes(response.status)) break;
      console.warn("Gemini model unavailable; trying next model", model, response.status, raw.slice(0, 300));
    }
    if (!response) return NextResponse.json({ error: lastError }, { status: lastStatus });
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
    const initialProductConfidence = Math.max(0, Math.min(1, Number(parsed.product_confidence) || 0));
    if ((!match || initialProductConfidence < 0.72) && catalogue.some((item: any) => item.reference_images.length)) {
      const visibleLabel = String(parsed.visible_label || parsed.brand_or_product || "").slice(0, 160);
      const ranked = catalogue.filter((item: any) => item.reference_images.length)
        .map((item: any) => ({ item, score: tokenOverlap(visibleLabel, item.brand + " " + item.product_name) }))
        .sort((a: any, b: any) => b.score - a.score);
      const shortlist: any[] = [];
      if (match?.reference_images.length) shortlist.push(match);
      if (visibleLabel) for (const candidate of ranked) {
        if (shortlist.some(item => item.id === candidate.item.id)) continue;
        if (candidate.score < 0.08) continue;
        shortlist.push(candidate.item);
        if (shortlist.length >= 5) break;
      }
      const imageParts: any[] = [];
      for (const candidate of shortlist) {
        for (const reference of candidate.reference_images.slice(0, 2)) {
          const downloaded = await fetchReferenceImage(reference.url);
          if (!downloaded) continue;
          imageParts.push({ text: `Reference for catalogue id ${candidate.id}: ${candidate.brand} ${candidate.product_name}, ${reference.label} (${reference.angle}).` });
          imageParts.push({ inline_data: { mime_type: downloaded.mimeType, data: downloaded.data } });
          if (imageParts.filter((part: any) => part.inline_data).length >= 8) break;
        }
        if (imageParts.filter((part: any) => part.inline_data).length >= 8) break;
      }
      if (imageParts.some((part: any) => part.inline_data)) {
        try {
          const retryPrompt = [
            "The first bottle scan was uncertain. Compare the camera photo with the supplied online reference views to identify the exact product. Reference images are grouped by catalogue id and angle; they may show only part of the package.",
            "Use references to resolve brand and bottle-design identity only. Measure fill and read printed size from the live camera photo, never infer them from reference photos.",
            "Return product_id only if a reference visibly supports that exact bottle. Otherwise use an empty product_id. Read fill_tenths as an integer from 0 to 10. If the bottle is tilted, opaque, obscured, or the meniscus is unclear set needs_review true.",
            "Return JSON only with keys product_id, product_confidence, visible_label, fill_tenths, confidence, needs_review, notes.",
            "Possible catalogue matches: " + JSON.stringify(shortlist.map(({ reference_images: _references, ...item }: any) => item)),
          ].join("\n");
          const retry = await requestModelJson([
            { text: retryPrompt },
            { inline_data: { mime_type: image.mimeType, data: image.data } },
            ...imageParts,
          ], key, 400);
          const retryMatch = catalogue.find((item: any) => item.id === String(retry.product_id || ""));
          const retryConfidence = Math.max(0, Math.min(1, Number(retry.product_confidence) || 0));
          if (retryMatch && (!match || retryConfidence >= initialProductConfidence)) {
            parsed = retry;
            match = retryMatch;
          }
        } catch (error: any) {
          console.info("Bottle reference comparison was unavailable", error?.message || "retry failed");
        }
      }
    }
    if (!match && (parsed.brand_or_product || parsed.visible_label)) {
      const guess = String(parsed.brand_or_product || parsed.visible_label).toLowerCase();
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

