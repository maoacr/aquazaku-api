import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { users } from '@/db/schema'

export interface PerfilDeUsuario {
  id: string
  name: string
  email: string
  status: 'active' | 'inactive'
  mustChangePassword: boolean
}

/**
 * Datos de perfil del usuario.
 *
 * `requireAuth` deja en `req.user` solo lo que la autorización necesita: id y
 * roles. El nombre, el email y el flag de cambio de contraseña los usa la UI,
 * no la matriz de permisos, así que se traen acá — en el único endpoint que los
 * pide — en vez de engordar el contexto de cada request del sistema.
 */
export async function perfilDe(userId: string): Promise<PerfilDeUsuario | null> {
  const [usuario] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  return usuario ?? null
}
