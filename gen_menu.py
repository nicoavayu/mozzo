from PIL import Image, ImageDraw, ImageFont
import os

img = Image.new('RGB', (800, 1000), color = (255, 255, 255))
d = ImageDraw.Draw(img)

text = """
ENTRADAS
Tequeños de Queso  $5.50
Palitos de queso envueltos en masa frita.

Sopa del Día  $4.00
Pregunte a su mesero por la especialidad.

PLATOS PRINCIPALES
Lomo Saltado  $15.00
Trozos de carne con cebolla, tomate y papas fritas.

Arroz con Mariscos $18.50
Mixtura de mariscos frescos.

POSTRES
Tiramisu  $6.00
Tradicional postre italiano con cafe.

BEBIDAS
Chicha Morada  $3.00
Bebida refrescante de maiz.
"""
d.text((50, 50), text, fill=(0,0,0))
dest = '/Users/nixon/Desktop/Mozzo/test_menu.jpg'
img = img.convert('RGB')
img.save(dest, 'JPEG')
print(f"Salvada a {dest}")
