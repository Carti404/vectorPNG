# vectorPNG
Está Herramienta tiene como finalidad vectorizar imagenes PNG usando modelos Free endpoints de NVIDIA

Se usa potrace que sirve para trazar paths reales de la imagen (forma exacta), el módelo analiza la imagen y asigna los colores correctos a cada región. El servidor combina ambos en un SVG final
para arrancar es necesario ejecutar 'node server.js' el cual levanta un proxy en localhost y evita errores CORS 
