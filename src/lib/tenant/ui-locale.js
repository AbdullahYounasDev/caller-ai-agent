import { getAgentConfig } from "@/lib/tenant/config";
import { resolveLocale } from "@/lib/i18n";

/**
 * UI language for this request.
 *
 * ORDER, and it differs from the conversation-locale order on purpose:
 *   1. an explicit ?locale= — the dashboard previewing a language mid-change
 *   2. the tenant's SAVED uiLocale — an explicit decision by the business owner
 *   3. the browser's Accept-Language — a guess about a first-time visitor
 *   4. English
 *
 * A saved preference outranks the browser header here, which is the reverse of
 * how an end customer's language is chosen. The difference is who is speaking:
 * a business owner who set their dashboard to Urdu means it, and shouldn't
 * be overridden by an en-US browser. An end customer never set anything, so
 * their browser is the best signal we have about them.
 */
export async function uiLocaleFor(request, tenantId) {
  let saved;
  if (tenantId) {
    try {
      saved = (await getAgentConfig(tenantId)).uiLocale;
    } catch {
      // A config read failing must not turn into a wrong-language error message
      // on top of whatever actually went wrong.
    }
  }

  return resolveLocale({
    // Both count as "explicit"; the query param wins by being checked first.
    requested: request.nextUrl.searchParams.get("locale") || saved,
    acceptLanguage: request.headers.get("accept-language"),
    enabled: undefined, // dashboard language is not limited by customer languages
    fallback: undefined,
  });
}

