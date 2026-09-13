# Controles y UX de Phonepad

Estado del cliente nativo al 12 de septiembre de 2026.

## Pantalla y teclado

La transmisión mantiene una vista de pantalla completa independiente del teclado.
Solo el campo flotante sigue su altura animada, con desplazamiento cero explícito
cuando está cerrado, oculto o deshabilitado. El panel de atajos puede desplazarse
si el teclado deja poco espacio. Girar cierra teclado/paneles y conserva la sesión
RTC. En horizontal la transmisión oculta el campo; el control lateral abre la barra
vertical y permite solicitar el teclado.

El campo compacto contiene +, Escribir y Enter alineados. Al enfocar se expande.
El menú + usa FullWindowOverlay de iOS para conservar el foco, con límites del
área segura. Cámara/Fotos/Archivos usan los selectores nativos. Una transferencia
prepara el portapapeles de la laptop y ofrece Pegar ahora; nunca envía un prompt.

## Teclas

| Control | Acción remota |
| --- | --- |
| Return del teclado del teléfono | Shift+Enter: salto de línea en los campos de chat habituales |
| Enter del campo Escribir | Enter sin modificadores; envía según la aplicación enfocada |
| Ctrl / Alt / Super / Shift | Modificador de una sola acción; combinar con una tecla o flecha |
| Esc / Tab | Escape / Tab; con Alt+Tab cambia de aplicación, Shift+Tab retrocede |
| Flechas | Mover el cursor; Shift+flecha selecciona, Ctrl+flecha depende de la aplicación |
| Copiar / Pegar | Ctrl+C / Ctrl+V en la computadora; limpia modificadores seleccionados |

Las etiquetas Copiar/Pegar y Esc/Tab son texto visible. Las flechas y Enter usan
símbolos con nombres accesibles. Las teclas y controles tienen áreas de al menos
44 puntos. Los atajos se aplican a la ventana que tenga foco en Linux; no cambian
la configuración de esa aplicación. En terminales, Ctrl+Shift+V se obtiene
activando Ctrl y Shift y escribiendo v; Ctrl+V no pega en todas las terminales.

El texto se transmite al escribir y no se vuelve a enviar al pulsar Enter. Los
saltos de línea nunca pasan como texto ASCII al inyector (eso generaría Enter).
Navegar, copiar, pegar o usar un atajo reinicia el contexto local de edición para
no borrar texto remoto al seguir escribiendo. Los combos con caracteres fuera
del mapa US dependen del soporte del inyector; el texto Unicode usa portapapeles.

## Trackpad

El cliente reenvía contactos multitáctiles; libinput interpreta movimiento, tap,
scroll, pinch, swipe y doble toque con arrastre según el escritorio. Rotación,
interrupción o pérdida de transporte cancela contactos, sin convertirlos en clic.
El video no transforma la superficie en un mapa de clics absolutos.

## Verificación

Las regresiones móviles cubren altura de teclado obsoleta, varios giros, foco,
menú, adjuntos, Return, todos los atajos visibles y cancelación de gestos. Go
comprueba los códigos y el orden de pulsación/liberación de teclas sin tocar
ventanas del usuario. La última comprobación visual en iPhone debe registrarse
por separado en el informe de entrega.
