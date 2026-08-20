import { z } from 'zod'
import { ROLES } from '@/modules/authz/matrix'

/**
 * Los roles válidos salen de `ROLES`, la misma constante que usa la matriz de
 * permisos. Escribirlos otra vez acá dejaría dos listas que se desincronizan el
 * día que se agregue un rol.
 */
const rolValido = z.enum(ROLES as unknown as [string, ...string[]])

export const esquemaAltaDeUsuario = z.object({
  email: z.email('el email no es válido'),
  name: z.string().trim().min(1, 'el nombre es obligatorio'),
  password: z.string().min(8, 'la contraseña necesita al menos 8 caracteres'),
  // Se permite crear sin roles: alguien puede darse de alta y asignarse los
  // permisos después. Un usuario sin roles entra y no ve nada, que es un estado
  // válido y visible, no un error.
  roles: z.array(rolValido).default([]),
})

export const esquemaEdicionDeUsuario = z
  .object({
    name: z.string().trim().min(1).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'no se envió ningún campo para modificar',
  })

export const esquemaDeRoles = z.object({
  roles: z.array(rolValido),
})

export type AltaDeUsuario = z.infer<typeof esquemaAltaDeUsuario>
export type EdicionDeUsuario = z.infer<typeof esquemaEdicionDeUsuario>
