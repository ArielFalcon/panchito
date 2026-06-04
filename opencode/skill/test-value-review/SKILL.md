---
name: test-value-review
description: Cómo juzgar si un test E2E APORTA VALOR (no solo si está verde). Catálogo de anti-patrones de falso positivo y cómo detectarlos. Úsala al revisar tests (rol qa-reviewer).
---

# Revisión de VALOR de un test

Un test verde no vale nada si **no se pondría rojo cuando la funcionalidad se
rompe**. Tu trabajo no es comprobar que el test pasa: es **intentar demostrar que
el test no sirve**. Asume mala fe del test hasta que demuestre lo contrario.

## La pregunta central

> *¿Existe una forma de que la feature esté rota y este test SIGA en verde?*

Si la respuesta es sí, el test es un falso positivo → `approved: false` con una
corrección concreta.

## Catálogo de anti-patrones (rechaza si ves alguno)

1. **Assert ausente o trivial.** Solo hace clics/navega; o asevera algo que es
   cierto siempre (`toBeVisible()` de algo que ya estaba, `expect(true)`,
   comprobar que la URL existe). → Pide un assert sobre el **resultado** del flujo.
2. **Assert no ligado al cambio.** El objetivo dice "X" pero el assert verifica
   "Y" no relacionado. → El test no cubre lo que dice cubrir.
3. **Aceptaría el camino roto.** Si la acción fallara en silencio, el test
   pasaría igual (p. ej. asevera que aparece un botón, no que la operación
   ocurrió). → Aserta el efecto, no la mera presencia de UI.
4. **Tautología / depende de su propio mock.** Comprueba algo que el propio test
   montó, o mockea la red (aquí prohibido) y verifica el mock. → Sin valor.
5. **Datos preexistentes.** Asume que existe un dato real ("usuario admin",
   "pedido 42") en vez de crearlo namespaced. → Frágil y no aislado.
6. **No determinista.** `waitForTimeout`, orden implícito entre tests, locators
   CSS/XPath frágiles, sin cleanup. → Flaky garantizado.
7. **Sin limpieza.** Crea datos y no registra su borrado con `cleanup`. → Ensucia
   DEV y degrada el entorno.
8. **Cobertura que ignora el cambio.** El diff toca un flujo que el test no
   ejercita. → Falta el test del flujo afectado.
9. **Metadata incoherente.** El `objective`/`targets` del manifest no se
   corresponde con lo que el test hace de verdad.
10. **Oráculo débil.** Verifica un estado intermedio en vez del resultado final
    observable por el usuario.

## Cómo emites el veredicto

Por cada problema, una corrección **específica y accionable** (qué cambiar y por
qué). Si y solo si no encuentras ninguno tras intentarlo de verdad, aprueba.

```json
{ "approved": false, "corrections": ["El test asevera que el botón 'Publicar' es visible, pero no que la foto se publicó: pasaría aunque la subida falle. Asevera que aparece la publicación creada con su id namespaced."] }
```
