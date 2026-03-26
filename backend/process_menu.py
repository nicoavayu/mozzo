import json
import re
import sys
import unicodedata
from collections import defaultdict
from statistics import median

PRICE_PATTERN = re.compile(r'(?<!\d)(?:\$|s\/)?\s*(\d{1,4}(?:[.,]\d{1,2})?)(?!\d)')
TAIL_PRICE_PATTERN = re.compile(r'(?<!\d)(?:\$|s\/)?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$')
CATEGORY_KEYWORDS = {
    "entrada", "entradas", "principal", "principales", "plato", "platos",
    "bebida", "bebidas", "postre", "postres", "especialidad", "especialidades",
    "ensalada", "ensaladas", "sopa", "sopas", "menu", "menú", "desayuno",
    "almuerzo", "cena", "parrilla", "pastas", "pizza", "pizzas", "sandwich",
    "sandwiches", "cafeteria", "cafetería", "cocktails", "cocteles", "coctel",
}
BEVERAGE_KEYWORDS = {
    "agua", "gaseosa", "jugo", "jugo natural", "limonada", "cafe", "café",
    "té", "te", "cerveza", "vino", "sprite", "coca", "coca-cola", "fanta",
    "pepsi", "bebida", "bebidas", "smoothie", "licuado",
}
MENU_TITLE_KEYWORDS = {"menu", "menú", "día", "dia", "especial", "especialidades"}
GARBAGE_TOKENS = {"|", "_", "]", "[", "¦", "=", "~", "`", "•", "°"}
SERVICE_NOTE_KEYWORDS = {
    "pregunte", "pregunta", "consulte", "consulta", "consultar", "mesero", "mozo",
    "camarero", "chef", "disponibilidad", "sujeto", "segun", "según",
}
SERVICE_NOTE_PHRASES = (
    "pregunte a su",
    "pregunte por",
    "consulte con",
    "consulte por",
    "consulta por",
    "segun disponibilidad",
    "según disponibilidad",
    "sujeto a disponibilidad",
)


def normalize_text(value):
    text = unicodedata.normalize("NFKC", str(value or ""))
    replacements = {
        "—": "-",
        "–": "-",
        "•": " ",
        "·": " ",
        "|": " ",
        "¦": " ",
        "[": " ",
        "]": " ",
        "_": " ",
        "¢": "c",
    }

    for source, target in replacements.items():
        text = text.replace(source, target)

    text = re.sub(r"[^\w\s\.,:/&+\-$()%áéíóúÁÉÍÓÚñÑ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" .-:/")
    return text


def tokenize(text):
    return re.findall(r"\w+", text.lower())


def symbol_ratio(text):
    if not text:
        return 1

    symbol_count = sum(1 for char in text if not char.isalnum() and not char.isspace())
    return symbol_count / len(text)


def average(values):
    if not values:
        return 0

    return sum(values) / len(values)


def has_price_hint(text):
    return PRICE_PATTERN.search(text) is not None


def analyze_price_style(lines):
    explicit_decimal_count = 0
    compact_integer_count = 0
    compact_samples = []

    for line in lines:
        for match in PRICE_PATTERN.finditer(line["text"]):
            raw_value = match.group(1)
            if "." in raw_value or "," in raw_value:
                explicit_decimal_count += 1
            elif raw_value.isdigit():
                compact_integer_count += 1
                compact_samples.append(int(raw_value))

    compact_median = median(compact_samples) if compact_samples else 0
    assume_compact_decimals = False

    if compact_integer_count >= 2 and explicit_decimal_count >= 2:
        assume_compact_decimals = compact_median >= 100
    elif compact_integer_count >= 2 and explicit_decimal_count >= 1 and compact_median >= 100:
        assume_compact_decimals = True
    elif compact_integer_count >= 3 and compact_median >= 100:
        assume_compact_decimals = True

    return {
        "explicit_decimal_count": explicit_decimal_count,
        "compact_integer_count": compact_integer_count,
        "compact_median": compact_median,
        "assume_compact_decimals": assume_compact_decimals,
    }


def parse_price_number(raw_value, price_style=None):
    raw_text = str(raw_value or "").strip()
    if not raw_text:
        return None

    normalized = raw_text.replace(",", ".")
    inferred_decimal = False

    if "." in normalized:
        try:
            value = float(normalized)
        except ValueError:
            return None
    else:
        digits = re.sub(r"\D", "", normalized)
        if not digits:
            return None

        if (
            price_style
            and price_style.get("assume_compact_decimals")
            and len(digits) >= 3
            and int(digits) >= 100
        ):
            value = int(digits) / 100
            inferred_decimal = True
        else:
            value = float(int(digits))

    if value <= 0 or value > 500:
        return None

    return {
        "value": round(value, 2),
        "raw": raw_text,
        "normalized_from_compact": inferred_decimal,
    }


def extract_price(text, price_style=None):
    tail_match = TAIL_PRICE_PATTERN.search(text)
    if tail_match:
        price_data = parse_price_number(tail_match.group(1), price_style)
        return price_data, tail_match.group(0)

    matches = list(PRICE_PATTERN.finditer(text))
    if not matches:
        return None, None

    last_match = matches[-1]
    price_data = parse_price_number(last_match.group(1), price_style)
    return price_data, last_match.group(0)


def is_decorative(text):
    cleaned = normalize_text(text)
    if not cleaned:
        return True

    if cleaned in GARBAGE_TOKENS:
        return True

    if re.fullmatch(r"[-=:/\s]+", cleaned):
        return True

    if symbol_ratio(cleaned) > 0.35:
        return True

    alpha_count = sum(1 for char in cleaned if char.isalpha())
    digit_count = sum(1 for char in cleaned if char.isdigit())
    if alpha_count + digit_count < 2:
        return True

    return False


def build_stats(lines):
    heights = [line["line_height"] for line in lines if line["line_height"] > 0]
    median_height = median(heights) if heights else 0
    return {
        "median_height": median_height,
        "tall_line_threshold": median_height * 1.28 if median_height else 0,
    }


def looks_like_category(text, stats, price_style=None):
    cleaned = normalize_text(text)
    if not cleaned:
        return False

    words = tokenize(cleaned)

    if has_price_hint(cleaned) or extract_price(cleaned, price_style)[0] is not None:
        return False

    uppercase_ratio = sum(1 for char in cleaned if char.isupper()) / max(
        1, sum(1 for char in cleaned if char.isalpha())
    )

    if any(keyword in words for keyword in CATEGORY_KEYWORDS) and len(words) <= 4 and len(cleaned) <= 40:
        if len(words) <= 2 or uppercase_ratio > 0.55:
            return True
        if stats and stats["tall_line_threshold"] and stats["line_height"] >= stats["tall_line_threshold"]:
            return True

    if len(words) <= 4 and len(cleaned) <= 32:
        if uppercase_ratio > 0.65:
            return True

    return (
        stats
        and stats["tall_line_threshold"]
        and stats["line_height"] >= stats["tall_line_threshold"]
        and len(words) <= 5
    )


def looks_like_description(line, stats, price_style=None):
    text = line["text"]
    words = tokenize(text)

    if has_price_hint(text) or extract_price(text, price_style)[0] is not None:
        return False

    if looks_like_category(text, stats, price_style):
        return False

    if len(words) >= 5:
        return True

    if len(words) >= 3 and len(text) >= 14:
        return True

    return len(text) >= 20 and line["confidence"] >= 35


def looks_like_service_note(line, price_style=None):
    text = normalize_text(line["text"])
    lowered = text.lower()
    words = tokenize(lowered)

    if not text or len(words) < 4:
        return False

    if has_price_hint(text) or extract_price(text, price_style)[0] is not None:
        return False

    if any(phrase in lowered for phrase in SERVICE_NOTE_PHRASES):
        return True

    if "mesero" in words or "mozo" in words or "camarero" in words:
        return True

    if any(keyword in words for keyword in SERVICE_NOTE_KEYWORDS):
        return re.search(r"\b(pregunte|consulte|consulta|consultar|sujeto)\b", lowered) is not None

    return False


def looks_like_beverage_block(items):
    if len(items) < 3:
        return False

    beverage_hits = 0
    for item in items:
        item_name = item.get("name", "").lower()
        if any(keyword in item_name for keyword in BEVERAGE_KEYWORDS):
            beverage_hits += 1

    short_name_ratio = sum(1 for item in items if len(item.get("name", "")) <= 18) / max(len(items), 1)
    return beverage_hits >= 2 or short_name_ratio > 0.8


def prepare_lines(payload_lines):
    prepared = []
    discarded = []

    for raw_line in payload_lines:
        cleaned_text = normalize_text(raw_line.get("text", ""))
        confidence = float(raw_line.get("confidence", 0) or 0)
        bbox = raw_line.get("bbox") or {}
        line_height = float(
            raw_line.get("row_height", 0)
            or max((bbox.get("y1", 0) - bbox.get("y0", 0)), 0)
        )
        block_type = str(raw_line.get("block_type", "unknown") or "unknown").lower()

        line = {
            "text": cleaned_text,
            "confidence": confidence,
            "bbox": bbox,
            "line_height": line_height,
            "block_index": int(raw_line.get("block_index", 0) or 0),
            "block_type": block_type,
            "words": [
                {
                    "text": normalize_text(word.get("text", "")),
                    "confidence": float(word.get("confidence", confidence) or confidence),
                    "bbox": word.get("bbox") or {},
                }
                for word in (raw_line.get("words") or [])
                if normalize_text(word.get("text", ""))
            ],
        }

        if not cleaned_text:
            discarded.append({
                "text": raw_line.get("text", ""),
                "reason": "empty_after_cleanup",
                "confidence": confidence,
            })
            continue

        if "image" in block_type:
            discarded.append({
                "text": cleaned_text,
                "reason": "image_block",
                "confidence": confidence,
            })
            continue

        if confidence < 18 and not has_price_hint(cleaned_text):
            discarded.append({
                "text": cleaned_text,
                "reason": "low_confidence_noise",
                "confidence": confidence,
            })
            continue

        if is_decorative(cleaned_text):
            discarded.append({
                "text": cleaned_text,
                "reason": "decorative_noise",
                "confidence": confidence,
            })
            continue

        prepared.append(line)

    prepared.sort(key=lambda line: (line["bbox"].get("y0", 0), line["bbox"].get("x0", 0)))
    return prepared, discarded


def assign_sections(lines, page_width):
    if not lines:
        return []

    threshold = 72
    if page_width:
        threshold = max(56, min(120, page_width * 0.12))

    clusters = []
    lines_sorted = sorted(lines, key=lambda line: (line["bbox"].get("x0", 0), line["bbox"].get("y0", 0)))

    for line in lines_sorted:
        x0 = line["bbox"].get("x0", 0)
        best_cluster = None
        best_distance = None

        for cluster in clusters:
            distance = abs(x0 - cluster["anchor_x"])
            if distance <= threshold and (best_distance is None or distance < best_distance):
                best_cluster = cluster
                best_distance = distance

        if best_cluster is None:
            best_cluster = {"anchor_x": x0, "lines": []}
            clusters.append(best_cluster)

        best_cluster["lines"].append(line)
        best_cluster["anchor_x"] = average(
            [cluster_line["bbox"].get("x0", 0) for cluster_line in best_cluster["lines"]]
        )

    clusters.sort(key=lambda cluster: cluster["anchor_x"])

    for index, cluster in enumerate(clusters):
        for line in cluster["lines"]:
            line["section_id"] = index

    return sorted(lines, key=lambda line: (
        line.get("section_id", 0),
        line["bbox"].get("y0", 0),
        line["bbox"].get("x0", 0),
    ))


def merge_price_only_lines(lines, stats, price_style):
    merged = []
    index = 0
    height_gap_limit = max(stats["median_height"] * 1.7, 18) if stats["median_height"] else 18

    while index < len(lines):
        line = dict(lines[index])
        text = line["text"]
        price_data, _ = extract_price(text, price_style)
        alpha_count = sum(1 for char in text if char.isalpha())

        if price_data is not None and alpha_count == 0 and merged:
            previous = merged[-1]
            same_section = previous.get("section_id") == line.get("section_id")
            vertical_gap = line["bbox"].get("y0", 0) - previous["bbox"].get("y1", 0)
            same_row = abs(line["bbox"].get("y0", 0) - previous["bbox"].get("y0", 0)) <= height_gap_limit
            previous_price_data, _ = extract_price(previous["text"], price_style)

            if same_section and (vertical_gap <= height_gap_limit or same_row) and previous_price_data is None:
                previous["text"] = f'{previous["text"]} ${price_data["value"]:.2f}'
                previous["bbox"]["x1"] = max(previous["bbox"].get("x1", 0), line["bbox"].get("x1", 0))
                previous["bbox"]["y1"] = max(previous["bbox"].get("y1", 0), line["bbox"].get("y1", 0))
                previous["confidence"] = min(previous["confidence"], line["confidence"])
                index += 1
                continue

        merged.append(line)
        index += 1

    return merged


def detect_menu_name(lines, stats):
    if not lines:
        return ""

    top_lines = [
        line for line in lines
        if line["bbox"].get("y0", 0) <= max(stats["median_height"] * 5, 140)
        and not has_price_hint(line["text"])
        and len(tokenize(line["text"])) <= 7
    ]

    if not top_lines:
        return ""

    top_lines.sort(
        key=lambda line: (
            -(line["line_height"] or 0),
            line["bbox"].get("y0", 0),
            line["bbox"].get("x0", 0),
        )
    )

    for line in top_lines:
        words = tokenize(line["text"])
        if any(keyword in words for keyword in MENU_TITLE_KEYWORDS):
            return line["text"][:80]

    candidate = top_lines[0]["text"]
    if looks_like_category(candidate, {**stats, "line_height": top_lines[0]["line_height"]}):
        return ""

    return candidate[:80]


def split_name_and_price(text, price_style):
    tail_match = TAIL_PRICE_PATTERN.search(text)
    if tail_match:
        price_data = parse_price_number(tail_match.group(1), price_style)
        if price_data is not None:
            name = normalize_text(text[:tail_match.start()])
            return name, price_data

    price_data, raw_price = extract_price(text, price_style)
    if price_data is None:
        return normalize_text(text), None

    name = normalize_text(text.replace(str(raw_price), "", 1))
    return name, price_data


def split_line_name_and_price(line, price_style):
    words = [word for word in (line.get("words") or []) if word.get("text")]

    if words:
        candidate_sizes = [1, 2]

        for size in candidate_sizes:
            if len(words) < size + 1:
                continue

            trailing_words = words[-size:]
            candidate_price = normalize_text(" ".join(word.get("text", "") for word in trailing_words))
            price_data = parse_price_number(candidate_price.replace("$", "").replace("s/", ""), price_style)

            if price_data is None:
                continue

            line_midpoint = (line["bbox"].get("x0", 0) + line["bbox"].get("x1", 0)) / 2
            trailing_x0 = trailing_words[0].get("bbox", {}).get("x0", line["bbox"].get("x1", 0))
            if trailing_x0 < line_midpoint:
                continue

            name = normalize_text(" ".join(word.get("text", "") for word in words[:-size]))
            if name:
                return name, price_data

    return split_name_and_price(line["text"], price_style)


def is_description_continuation(source_line, candidate_line, stats, price_style):
    if candidate_line.get("section_id") != source_line.get("section_id"):
        return False

    candidate_text = candidate_line["text"]
    if has_price_hint(candidate_text) or extract_price(candidate_text, price_style)[0] is not None:
        return False

    if looks_like_service_note(candidate_line, price_style):
        return False

    if looks_like_category(candidate_text, {**stats, "line_height": candidate_line["line_height"]}, price_style):
        return False

    vertical_gap = candidate_line["bbox"].get("y0", 0) - source_line["bbox"].get("y1", 0)
    gap_limit = max(stats["median_height"] * 1.6, 20) if stats["median_height"] else 20
    if vertical_gap > gap_limit:
        return False

    indent_delta = candidate_line["bbox"].get("x0", 0) - source_line["bbox"].get("x0", 0)
    if indent_delta < -8:
        return False

    if looks_like_description(candidate_line, {**stats, "line_height": candidate_line["line_height"]}, price_style):
        return True

    words = tokenize(candidate_text)
    return (
        2 <= len(words) <= 5
        and len(candidate_text) >= 10
        and indent_delta >= 0
        and candidate_line["line_height"] <= max(source_line["line_height"] * 1.05, candidate_line["line_height"])
    )


def ensure_category(categories, current_category_name, source_section):
    if (
        not categories
        or categories[-1]["name"] != current_category_name
        or categories[-1].get("_source_section") != source_section
    ):
        categories.append({
            "name": current_category_name,
            "items": [],
            "_source_section": source_section,
        })
    return categories[-1]


def compute_item_confidence(source_line, description_lines, flags):
    base_confidence = source_line["confidence"]
    if description_lines:
        base_confidence = (base_confidence * 0.75) + (average([line["confidence"] for line in description_lines]) * 0.25)

    base_confidence -= len(set(flags)) * 4
    return max(20, min(99, int(round(base_confidence))))


def append_suspicious_line(items, text, confidence, reasons):
    if not text or not reasons:
        return

    items.append({
        "text": text,
        "confidence": confidence,
        "reason": ", ".join(sorted(set(reasons))),
    })


def parse_section_lines(lines, stats, price_style, menu_name):
    categories = []
    discarded = []
    suspicious = []
    current_category_name = None
    index = 0
    section_id = lines[0].get("section_id", 0) if lines else 0

    while index < len(lines):
        line = lines[index]
        text = line["text"]

        if menu_name and normalize_text(text).lower() == normalize_text(menu_name).lower():
            index += 1
            continue

        if looks_like_service_note(line, price_style):
            discarded.append({
                "text": text,
                "reason": "service_note",
                "confidence": line["confidence"],
            })
            append_suspicious_line(suspicious, text, line["confidence"], ["service_note"])
            index += 1
            continue

        if looks_like_category(text, {**stats, "line_height": line["line_height"]}, price_style):
            current_category_name = text.title()
            ensure_category(categories, current_category_name, section_id)
            index += 1
            continue

        item_name, price_data = split_line_name_and_price(line, price_style)
        if price_data is not None:
            if not item_name or len(tokenize(item_name)) == 0:
                discarded.append({
                    "text": text,
                    "reason": "price_without_name",
                    "confidence": line["confidence"],
                })
                index += 1
                continue

            description_lines = []
            description_parts = []
            flags = []

            if price_data.get("normalized_from_compact"):
                flags.append("price_estimated_from_ocr")

            if line["confidence"] < 82:
                flags.append("low_confidence_name")

            if not current_category_name:
                flags.append("inferred_category")

            lookahead = index + 1
            while lookahead < len(lines):
                next_line = lines[lookahead]
                next_text = next_line["text"]

                if next_line.get("section_id") != line.get("section_id"):
                    break

                if not is_description_continuation(line, next_line, stats, price_style):
                    break

                description_lines.append(next_line)
                description_parts.append(next_text)

                if next_line["confidence"] < 75:
                    flags.append("low_confidence_description")

                lookahead += 1

            item = {
                "name": item_name,
                "description": " ".join(description_parts).strip(),
                "price": price_data["value"],
                "confidence": compute_item_confidence(line, description_lines, flags),
                "flags": sorted(set(flags)),
            }

            category = ensure_category(
                categories,
                current_category_name or "Especialidades",
                section_id,
            )
            category["items"].append(item)

            if item["flags"]:
                append_suspicious_line(suspicious, text, line["confidence"], item["flags"])

            for description_line in description_lines:
                if description_line["confidence"] < 75:
                    append_suspicious_line(
                        suspicious,
                        description_line["text"],
                        description_line["confidence"],
                        ["low_confidence_description"],
                    )

            index = lookahead
            continue

        if looks_like_description(line, {**stats, "line_height": line["line_height"]}, price_style):
            discarded.append({
                "text": text,
                "reason": "orphan_description",
                "confidence": line["confidence"],
            })
            index += 1
            continue

        discarded.append({
            "text": text,
            "reason": "unclassified_line",
            "confidence": line["confidence"],
        })
        index += 1

    categories = [
        {"name": category["name"], "items": category["items"]}
        for category in categories
        if category["items"]
    ]

    return categories, discarded, suspicious


def dedupe_lines(lines):
    seen = set()
    deduped = []

    for line in lines:
        key = (line.get("text"), line.get("reason"))
        if key in seen:
            continue

        seen.add(key)
        deduped.append(line)

    return deduped


def finalize_categories(categories):
    finalized = []

    for category in categories:
        flags = []
        category_name = category["name"]
        review_reasons = []

        if looks_like_beverage_block(category["items"]) and "bebida" not in category["name"].lower():
            category_name = "Bebidas"
            flags.append("heuristic_beverage_group")
            review_reasons.append("agrupada como bebidas por heurística")

        confidences = [item.get("confidence", 0) for item in category["items"] if item.get("confidence")]
        review_count = sum(1 for item in category["items"] if item.get("flags"))
        low_confidence_items = sum(
            1
            for item in category["items"]
            if item.get("confidence") is not None and item.get("confidence", 0) < 82
        )

        if review_count > 0:
            review_reasons.append(f"{review_count} item(s) con flags")
        if low_confidence_items > 0:
            review_reasons.append(f"{low_confidence_items} item(s) de baja confianza")

        confidence = int(round(average(confidences))) if confidences else None
        review_priority = review_count * 3
        if confidence is not None and confidence < 82:
            review_priority += 2
        if low_confidence_items > 0:
            review_priority += 1
        if "heuristic_beverage_group" in flags:
            review_priority += 1

        finalized.append({
            "name": category_name,
            "items": category["items"],
            "confidence": confidence,
            "review_count": review_count,
            "flags": flags,
            "review_priority": review_priority,
            "review_summary": review_reasons,
        })

    return finalized


def build_review_focus(categories, discarded_lines, suspicious_lines):
    estimated_prices = 0
    low_confidence_items = 0
    inferred_categories = 0
    heuristic_groups = 0

    for category in categories:
        if "heuristic_beverage_group" in category.get("flags", []):
            heuristic_groups += 1

        for item in category.get("items", []):
            item_flags = set(item.get("flags", []))
            if "price_estimated_from_ocr" in item_flags:
                estimated_prices += 1
            if "inferred_category" in item_flags:
                inferred_categories += 1
            if "low_confidence_name" in item_flags or "low_confidence_description" in item_flags:
                low_confidence_items += 1

    service_note_count = len({
        (line.get("text"), line.get("reason"))
        for line in [*discarded_lines, *suspicious_lines]
        if line.get("reason") == "service_note"
    })

    return {
        "items_to_review": sum(1 for category in categories for item in category.get("items", []) if item.get("flags")),
        "estimated_prices": estimated_prices,
        "low_confidence_items": low_confidence_items,
        "inferred_categories": inferred_categories,
        "heuristic_groups": heuristic_groups,
        "service_notes": service_note_count,
        "suspicious_lines": len(suspicious_lines),
        "discarded_lines": len(discarded_lines),
    }


def build_review_queue(categories):
    reviewable = [
        {
            "name": category.get("name"),
            "confidence": category.get("confidence"),
            "review_count": category.get("review_count", 0),
            "review_priority": category.get("review_priority", 0),
            "summary": category.get("review_summary", []),
            "flags": category.get("flags", []),
        }
        for category in categories
        if category.get("review_priority", 0) > 0
    ]

    reviewable.sort(
        key=lambda category: (
            -category.get("review_priority", 0),
            category.get("confidence") if category.get("confidence") is not None else 999,
            category.get("name") or "",
        )
    )

    return reviewable[:6]


def parse_legacy_text(text):
    raw_lines = [
        {
            "text": line.strip(),
            "confidence": 50,
            "bbox": {"x0": 0, "y0": index * 20, "x1": 1000, "y1": index * 20 + 18},
            "row_height": 18,
            "block_index": 0,
            "block_type": "text",
        }
        for index, line in enumerate(text.splitlines())
        if line.strip()
    ]

    return parse_payload({"text": text, "lines": raw_lines, "page": {"width": 1000}})


def parse_payload(payload):
    source_lines, discarded_lines = prepare_lines(payload.get("lines") or [])
    stats = build_stats(source_lines)
    price_style = analyze_price_style(source_lines)
    sectioned_lines = assign_sections(source_lines, (payload.get("page") or {}).get("width"))
    merged_lines = merge_price_only_lines(sectioned_lines, stats, price_style)
    menu_name = payload.get("menu_name") or detect_menu_name(merged_lines, stats)

    sections = defaultdict(list)
    for line in merged_lines:
        sections[line.get("section_id", 0)].append(line)

    categories = []
    parser_discarded = []
    suspicious_lines = []

    for section_id in sorted(sections):
        section_lines = sorted(
            sections[section_id],
            key=lambda line: (line["bbox"].get("y0", 0), line["bbox"].get("x0", 0)),
        )
        section_categories, section_discarded, section_suspicious = parse_section_lines(
            section_lines,
            stats,
            price_style,
            menu_name,
        )
        categories.extend(section_categories)
        parser_discarded.extend(section_discarded)
        suspicious_lines.extend(section_suspicious)

    categories = finalize_categories(categories)
    discarded_lines = dedupe_lines(discarded_lines + parser_discarded)
    suspicious_lines = dedupe_lines(suspicious_lines)
    review_focus = build_review_focus(categories, discarded_lines, suspicious_lines)
    review_queue = build_review_queue(categories)

    item_confidences = [
        item.get("confidence", 0)
        for category in categories
        for item in category.get("items", [])
    ]
    average_line_confidence = round(
        average([line["confidence"] for line in merged_lines]),
        2,
    )
    global_confidence = round(
        (average_line_confidence * 0.45) + (average(item_confidences) * 0.55 if item_confidences else average_line_confidence),
        2,
    )

    warnings = []
    if global_confidence < 72:
        warnings.append("La lectura tiene confianza media o baja. Revisá categorías, textos y precios antes de publicar.")

    if review_focus["estimated_prices"] > 0:
        warnings.append(
            f'Se normalizaron {review_focus["estimated_prices"]} precio(s) compactado(s) por OCR. Revisalos antes de publicar.'
        )

    if review_focus["low_confidence_items"] > 0:
        warnings.append(
            f'Hay {review_focus["low_confidence_items"]} item(s) con nombre o descripción de baja confianza.'
        )

    if review_focus["inferred_categories"] > 0:
        warnings.append(
            f'Se infirió la categoría de {review_focus["inferred_categories"]} item(s). Conviene reubicarlos si hace falta.'
        )

    if review_focus["heuristic_groups"] > 0:
        warnings.append("El importador agrupó una columna corta como Bebidas por heurística. Revisá ese bloque antes de publicar.")

    if review_focus["service_notes"] > 0:
        warnings.append("Se detectaron aclaraciones generales del menú que no se asociaron a un plato específico.")

    if len(suspicious_lines) > 0:
        warnings.append("Hay líneas o items dudosos marcados para revisión manual.")

    if len(discarded_lines) > max(len(merged_lines), 1):
        warnings.append("Se descartaron muchas líneas ruidosas. La imagen probablemente tiene decoración o contraste difícil.")

    if not categories:
        warnings.append("No se reconstruyó una estructura confiable. Conviene revisar manualmente o probar otra imagen.")

    return {
        "review_required": True,
        "name": menu_name or "Menú importado",
        "confidence": global_confidence,
        "categories": categories,
        "diagnostics": {
            "ocr_confidence": payload.get("confidence"),
            "global_confidence": global_confidence,
            "average_line_confidence": average_line_confidence,
            "line_count": len(source_lines),
            "usable_line_count": len(merged_lines),
            "discarded_count": len(discarded_lines),
            "suspicious_count": len(suspicious_lines),
            "section_count": len(sections),
            "rotation_radians": payload.get("rotate_radians", 0),
            "ocr_variant": (payload.get("preprocessing") or {}).get("selected", "original"),
            "preprocessing_steps": (payload.get("preprocessing") or {}).get("applied_steps", []),
            "price_style": {
                "explicit_decimal_count": price_style["explicit_decimal_count"],
                "compact_integer_count": price_style["compact_integer_count"],
                "assume_compact_decimals": price_style["assume_compact_decimals"],
            },
            "review_focus": review_focus,
            "review_queue": review_queue,
            "warnings": warnings,
        },
        "discarded_lines": discarded_lines[:20],
        "suspicious_lines": suspicious_lines[:20],
    }


if __name__ == "__main__":
    input_data = sys.stdin.read()
    if not input_data.strip():
        print(json.dumps({"error": "El texto de entrada está vacío"}, ensure_ascii=False))
        sys.exit(1)

    try:
        payload = json.loads(input_data)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, dict):
        parsed_data = parse_payload(payload)
    else:
        parsed_data = parse_legacy_text(input_data)

    print(json.dumps(parsed_data, ensure_ascii=False))
