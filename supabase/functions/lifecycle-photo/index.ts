// Supabase Edge Function entry. Deploy with JWT verification off: members use the publishable key and a
// booking token, which the database checks itself (see supabase/README.md, 017).
import { createPhotoHandler } from './handler.js';

Deno.serve(createPhotoHandler({ env: (name: string) => Deno.env.get(name) ?? '' }));
