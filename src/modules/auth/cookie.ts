/**
 * Nombre de la cookie de sesión.
 *
 * Vive en un módulo propio, **sin importar nada**, a propósito. Antes estaba en
 * `authz/middleware.ts`, que importa `better-auth.ts`, que a su vez importaba
 * esta constante de vuelta: un ciclo.
 *
 * Los ciclos de importación no fallan de entrada — fallan según el orden en que
 * se cargue el primer módulo. Acá el síntoma fue de los peores: la constante
 * llegaba `undefined` al construir la config, Better-Auth caía en su nombre de
 * cookie por defecto, y el login devolvía **200 con la sesión creada** pero con
 * la cookie bajo otro nombre. Todo "funcionaba" y nadie quedaba logueado.
 *
 * Una constante compartida entre dos módulos que se necesitan mutuamente va en
 * un tercero que no necesita a ninguno.
 */
export const COOKIE_SESION = 'aquazaku_session'
