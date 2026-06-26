/**
 * Cliente Supabase compartido — usa service_role key (bypass RLS).
 * NUNCA exponer SUPABASE_SERVICE_KEY al frontend.
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

module.exports = supabase;
