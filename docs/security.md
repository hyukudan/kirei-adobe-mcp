# Seguridad baseline

El daemon solo enlaza a loopback, valida origen, exige challenge-HMAC con token local de 256 bits, limita frames a 8 MiB y rechaza frames no conformes. Las rutas de usuario deben llegar mediante grants y pasar canonicalización. La ejecución arbitraria, shell, `eval` y scripts interpolados no forman parte del baseline.
