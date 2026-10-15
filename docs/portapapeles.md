# Portapapeles y texto

| Acción | Resultado |
| --- | --- |
| Pegar aquí | Inserta el texto copiado en el iPhone dentro del borrador, respetando la selección. |
| Al equipo | Copia el texto del portapapeles del iPhone al de la computadora. No lo pega en una aplicación. |
| Al iPhone | Copia el texto que ya está en el portapapeles de la computadora al iPhone. |
| Copiar | Ejecuta el atajo de copia en la computadora. |
| Pegar | Ejecuta el atajo de pegado en la computadora. |
| Enviar borrador | Envía el texto conservando el contenido previo del portapapeles de la computadora. |

Las transferencias entre portapapeles admiten texto Unicode de hasta 128 KiB. El texto vacío, incompleto o con caracteres nulos se rechaza sin reemplazar el destino. Fotos y archivos usan sus propias acciones. Las solicitudes verifican permisos y sesión; un error no provoca un segundo intento automático.

En Linux, el servidor intenta insertar el bloque mediante accesibilidad. Si la instalación habilita el pegado alternativo, conserva temporalmente todos los formatos MIME del portapapeles en memoria, hasta 32 formatos y 16 MiB. Si no puede conservarlos, rechaza el envío. Esa ruta necesita Python GI, GTK 4 y una sesión gráfica, con XWayland en GNOME.

El pegado alternativo envía una sola combinación de teclas y espera dos segundos antes de restaurar. Si otra aplicación copia mientras tanto, conserva esa copia nueva. El resultado `dispatched` confirma las teclas y la restauración; no demuestra por sí solo que la aplicación de destino haya insertado el texto. Ante un resultado incierto, PhonePad conserva el borrador para revisión.

La consulta de accesibilidad y la espera del pegado no bloquean el movimiento del cursor.
