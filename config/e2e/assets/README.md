# Assets de los tests (subida de fotos)

Aquí viven los ficheros (imágenes) que los tests suben, y su **metadata
opcional** en `assets.json`. El agente lee esa metadata para saber qué probar
con cada asset; se resuelve la ruta con `asset("foto.jpg")` (fixtures).

## `assets.json` — metadata por asset (opcional)

Array de entradas. Solo `file` es obligatorio; el resto explica el caso de uso:

```json
[
  {
    "file": "playa.jpg",
    "description": "Foto de playa con geolocalización en EXIF",
    "useCase": "subida con sitio cercano sugerido",
    "whatToTest": "que al subirla aparezca la lista de sitios cercanos y se pueda elegir uno"
  }
]
```

| Campo | Obligatorio | Para qué |
|---|---|---|
| `file` | sí | nombre del fichero en esta carpeta |
| `description` | no | qué es la imagen |
| `useCase` | no | en qué flujo se usa |
| `whatToTest` | no | qué debe verificar el test al subirla |
