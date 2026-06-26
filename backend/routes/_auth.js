/**
 * Middleware de autenticación multi-tenant.
 * Verifica el JWT de Supabase y resuelve a qué EMPRESA (company) pertenece el usuario.
 * Expone:
 *   req.userId    -> UUID del usuario autenticado
 *   req.companyId -> UUID de la empresa (todos los datos van scoped por aquí)
 *   req.role      -> 'admin' | 'member'
 *
 * Para agregar un usuario a una empresa: insertar fila en company_members
 * (user_id de Supabase Auth + company_id). Ver db/schema.sql.
 */
const supabase = require('./_supabase');

async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Sin token de autenticación' });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    req.userId = data.user.id;
    req.user   = data.user;

    // Multi-tenant: resolver la empresa del usuario
    const { data: member, error: mErr } = await supabase
      .from('company_members')
      .select('company_id, role')
      .eq('user_id', data.user.id)
      .maybeSingle();

    if (mErr)    return res.status(500).json({ error: mErr.message });
    if (!member) return res.status(403).json({ error: 'Usuario sin empresa asignada' });

    req.companyId = member.company_id;
    req.role      = member.role;

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Error verificando token' });
  }
}

module.exports = { requireAuth };
