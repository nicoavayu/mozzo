import sys
import json
import re

def parse_menu(text):
    categories = []
    current_category = None
    items = []
    
    category_keywords = {"entrada", "entradas", "principal", "principales", "plato", "platos", "bebida", "bebidas", "postre", "postres", "especialidad", "especialidades", "ensalada", "ensaladas", "sopa", "sopas"}
    
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
            
        price_match = re.search(r'\$?(\d+[\.,]\d{2}|\d+)\s*(€|\$|usd)?', line, re.IGNORECASE)
        
        is_category = False
        words = set(re.findall(r'\w+', line.lower()))
        
        if not price_match and len(line) < 30:
            if any(kw in words for kw in category_keywords):
                is_category = True
        
        if is_category or (not price_match and len(line) < 25 and line.isupper()):
            if current_category:
                categories.append({"name": current_category, "items": items})
            current_category = line.title()
            items = []
            i += 1
            continue
            
        if price_match:
            price_str = price_match.group(0)
            price_val_str = price_match.group(1).replace(',', '.')
            try:
                price_val = float(price_val_str)
            except ValueError:
                price_val = 0.0
                
            name = line.replace(price_str, '').strip().strip('.-_:=')
            
            desc = ""
            if i + 1 < len(lines):
                next_line = lines[i+1].strip()
                if next_line and not re.search(r'\$?(\d+[\.,]\d{2}|\d+)', next_line):
                    next_words = set(re.findall(r'\w+', next_line.lower()))
                    is_next_category = any(kw in next_words for kw in category_keywords)
                    if not is_next_category and not next_line.isupper() and len(next_line) > 10:
                        desc = next_line
                        i += 1
                        
            items.append({
                "name": name,
                "price": price_val,
                "description": desc
            })
            
        i += 1
        
    if current_category or items:
        categories.append({"name": current_category or "Categoría General", "items": items})
        
    return categories

if __name__ == "__main__":
    input_text = sys.stdin.read()
    if not input_text.strip():
        print(json.dumps({"error": "El texto de entrada está vacío"}))
        sys.exit(1)
        
    parsed_data = parse_menu(input_text)
    print(json.dumps({"categories": parsed_data}))
