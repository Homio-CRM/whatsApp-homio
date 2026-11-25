import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SupabaseClient = ReturnType<typeof createClient>;

export function getSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
}
