# Trigger: post-deploy (merge a main → DEV estable)

Se dispara tras confirmar que DEV corre el SHA del commit recién mergeado.
El objetivo es generar y ejecutar E2E sobre el blast radius del cambio y
reportar por GitHub Issue solo si algo falla.
