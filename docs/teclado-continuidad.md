# Teclado compacto y continuidad

Instalado: barra de 48 px con Voz, teclas especiales plegables y Listo.
El foco de escritura se abre directamente desde Teclado; VisualViewport ajusta
altura y desplazamiento. Cerrar pliega extras y libera el foco. No hay backdrop
que inutilice el pad. Recuperación limpia la pausa tras reemplazo de sesión.
Actualizaciones esperan mientras hay escritura enfocada, dictado o dedos activos.

Validado: 12 pruebas JS. Navegador Chromium: 393x852 -> barra48/pad752;
852x300 -> barra48/pad208, sin desbordes. Extras abiertos limitados a120px;
al cerrar barra0 y foco liberado. Binario actualizado y servicio activo.
Estas mediciones no equivalen a ejecutar el teclado nativo en un iPhone físico.
No se han demostrado voz en Safari ni transmisión de video entre redes.
