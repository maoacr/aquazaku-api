/**
 * Falla una regla de negocio. La ruta la traduce a un status HTTP.
 *
 * El `code` es un identificador estable que viaja al frontend: la UI decide qué
 * hacer con `ULTIMO_ADMIN` o `PRECIO_MINIMO_INVALIDO` sin parsear un mensaje en
 * castellano, que puede reescribirse sin aviso. El mensaje es para la persona;
 * el código, para el programa.
 */
export class ErrorDeNegocio extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    mensaje: string,
  ) {
    super(mensaje)
    this.name = 'ErrorDeNegocio'
  }
}
