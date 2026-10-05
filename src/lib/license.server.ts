import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

export function generateLicenseKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 4) groups.push(chars.slice(i, i + 4).join(""));
  return `MACD-${groups.join("-")}`;
}

export function normalizeKey(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

export function adminClient(): SupabaseClient {
  return createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false },
  });
}

/**
 * Creates a license for a subscription bought before Pro became a lifetime purchase.
 * Idempotent: a subscription that already has a key keeps the same key. Those licenses are
 * lifetime too, so a cancelled or lapsed subscription no longer revokes them.
 */
export async function issueLicenseForSubscription(params: {
  email: string;
  subscriptionId: string | null;
  active: boolean;
}): Promise<void> {
  const supabase = adminClient();

  if (params.subscriptionId) {
    const { data: existing } = await supabase
      .from("licenses")
      .select("id")
      .eq("dodo_subscription_id", params.subscriptionId)
      .maybeSingle();

    if (existing) return;
  }

  if (!params.active) return;

  await supabase.from("licenses").insert({
    license_key: generateLicenseKey(),
    email: params.email,
    dodo_subscription_id: params.subscriptionId,
    status: "active",
  });
}

export type DodoSubscriptionEvent = {
  email: string;
  customerId: string | null;
  subscriptionId: string | null;
  productId: string | null;
  status: string;
  currentPeriodEnd: string | null;
};

/** Stores a Dodo subscription and issues (or revokes) its license. Safe to call repeatedly. */
export async function recordSubscription(sub: DodoSubscriptionEvent): Promise<void> {
  const supabase = adminClient();
  const { error } = await supabase.from("dodo_subscriptions").upsert(
    {
      email: sub.email,
      customer_id: sub.customerId,
      dodo_subscription_id: sub.subscriptionId,
      product_id: sub.productId,
      status: sub.status,
      current_period_end: sub.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "dodo_subscription_id" },
  );
  if (error) throw new Error(`Subscription upsert failed: ${error.message}`);

  await issueLicenseForSubscription({
    email: sub.email,
    subscriptionId: sub.subscriptionId,
    active: sub.status === "active",
  });
}

export type DodoPaymentEvent = {
  paymentId: string;
  email: string;
  customerId: string | null;
  productId: string | null;
  status: string;
  totalAmount: number;
  currency: string | null;
  refunded: boolean;
};

/**
 * Stores a one-time Dodo payment for MacDissect Pro and issues its lifetime license, or revokes
 * the license when the payment was refunded. Safe to call repeatedly for the same payment.
 */
export async function recordPayment(payment: DodoPaymentEvent): Promise<void> {
  const supabase = adminClient();
  const { error } = await supabase.from("dodo_payments").upsert(
    {
      dodo_payment_id: payment.paymentId,
      email: payment.email,
      customer_id: payment.customerId,
      product_id: payment.productId,
      status: payment.status,
      total_amount: payment.totalAmount,
      currency: payment.currency,
      refunded: payment.refunded,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "dodo_payment_id" },
  );
  if (error) throw new Error(`Payment upsert failed: ${error.message}`);

  const { data: existing } = await supabase
    .from("licenses")
    .select("id")
    .eq("dodo_payment_id", payment.paymentId)
    .maybeSingle();

  if (payment.refunded) {
    if (existing)
      await supabase.from("licenses").update({ status: "revoked" }).eq("id", existing.id);
    return;
  }
  if (existing || payment.status !== "succeeded") return;

  const { error: insertError } = await supabase.from("licenses").insert({
    license_key: generateLicenseKey(),
    email: payment.email,
    dodo_payment_id: payment.paymentId,
    status: "active",
  });
  // 23505: a concurrent webhook delivery already issued this payment's license.
  if (insertError && insertError.code !== "23505")
    throw new Error(`License insert failed: ${insertError.message}`);
}

/** Marks a refunded payment and revokes its license, so every Mac using it locks. */
export async function recordRefund(paymentId: string): Promise<void> {
  const supabase = adminClient();
  await supabase
    .from("dodo_payments")
    .update({ refunded: true, updated_at: new Date().toISOString() })
    .eq("dodo_payment_id", paymentId);
  await supabase.from("licenses").update({ status: "revoked" }).eq("dodo_payment_id", paymentId);
}

/** Launch offer: the first this-many MacDissect Pro licenses are free for life. */
export const FREE_LICENSE_LIMIT = 50;

/**
 * Atomically claims one of the launch's free lifetime licenses and issues it immediately, if any
 * remain. Dodo's hosted checkout can't skip its card form on a $0 one-time purchase (only
 * subscriptions support that), so a free claim never goes through Dodo — it's recorded and
 * issued directly. Returns null if the free-license limit was already reached, in which case
 * the caller should fall back to the regular paid Dodo checkout.
 *
 * The key is handed back to the caller to show on screen immediately: nothing else notifies the
 * claimer of it (no receipt goes through Dodo for a $0 claim). We also best-effort invite them to
 * create a website account, so the key still shows up on /account if they come back later —
 * but that invite email is not guaranteed to arrive, so the caller must not rely on it alone.
 */
export async function claimFreeLicense(params: {
  email: string;
  productId: string | null;
  redirectTo?: string;
}): Promise<string | null> {
  const supabase = adminClient();
  const paymentId = `free_${crypto.randomUUID()}`;
  const { data: reserved, error } = await supabase.rpc("reserve_free_license_claim", {
    p_payment_id: paymentId,
    p_email: params.email,
    p_product_id: params.productId,
    p_limit: FREE_LICENSE_LIMIT,
  });
  if (error) throw new Error(`Free license reservation failed: ${error.message}`);
  if (!reserved) return null;

  const licenseKey = generateLicenseKey();
  const { error: insertError } = await supabase.from("licenses").insert({
    license_key: licenseKey,
    email: params.email,
    dodo_payment_id: paymentId,
    status: "active",
  });
  if (insertError) throw new Error(`License insert failed: ${insertError.message}`);

  try {
    await supabase.auth.admin.inviteUserByEmail(
      params.email,
      params.redirectTo ? { redirectTo: params.redirectTo } : undefined,
    );
  } catch (e) {
    // Best-effort: the key above is the claimer's real proof, this is just a convenience so it
    // also shows up on /account. A user who already has an account gets no invite, which is fine.
    console.error("Free license invite email failed:", e);
  }

  return licenseKey;
}

/** How many free launch licenses have been claimed. */
export async function countFreeLicenseClaims(): Promise<number> {
  const { data, error } = await adminClient().rpc("get_free_license_claims");
  if (error) throw new Error(`Free license count failed: ${error.message}`);
  return Number(data ?? 0);
}

/** True when this email already holds an active MacDissect Pro license. */
export async function hasActiveLicense(email: string): Promise<boolean> {
  const { count } = await adminClient()
    .from("licenses")
    .select("id", { count: "exact", head: true })
    .ilike("email", email)
    .eq("status", "active");
  return (count ?? 0) > 0;
}

function dodoBaseUrl() {
  return process.env["DODO_ENVIRONMENT"] === "live"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";
}

type DodoListItem = {
  subscription_id: string;
  status: string;
  product_id: string;
  next_billing_date: string | null;
  customer: { customer_id: string; email: string };
};

type DodoPaymentListItem = {
  payment_id: string;
  status: string;
  total_amount: number;
  currency: string | null;
  subscription_id: string | null;
  refund_status?: string | null;
  customer: { customer_id: string; email: string };
};

/**
 * Pulls this email's MacDissect Pro purchases (lifetime payments, and subscriptions from before
 * Pro became lifetime) straight from Dodo and records them. Covers webhooks that never arrived
 * (local dev, outages), so a customer always gets a key.
 */
export async function syncSubscriptionsFromDodo(email: string): Promise<number> {
  const apiKey = process.env["DODO_PAYMENTS_API_KEY"];
  const productId = process.env["DODO_PRODUCT_ID"];
  if (!apiKey || !email) return 0;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${dodoBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Dodo ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  };

  const customers = await get<{ items: { customer_id: string; email: string }[] }>(
    `/customers?email=${encodeURIComponent(email)}`,
  );

  let recorded = 0;
  for (const customer of customers.items) {
    if (customer.email.toLowerCase() !== email.toLowerCase()) continue;
    if (productId) {
      const payments = await get<{ items: DodoPaymentListItem[] }>(
        `/payments?customer_id=${encodeURIComponent(customer.customer_id)}&product_id=${encodeURIComponent(productId)}&status=succeeded&page_size=100`,
      );
      for (const p of payments.items) {
        if (p.subscription_id) continue; // renewals of a legacy subscription, handled below
        await recordPayment({
          paymentId: p.payment_id,
          email: p.customer.email,
          customerId: p.customer.customer_id,
          productId,
          status: p.status,
          totalAmount: p.total_amount,
          currency: p.currency,
          refunded: p.refund_status === "full" || p.refund_status === "succeeded",
        });
        recorded++;
      }
    }
    const subs = await get<{ items: DodoListItem[] }>(
      `/subscriptions?customer_id=${encodeURIComponent(customer.customer_id)}&page_size=100`,
    );
    for (const s of subs.items) {
      if (productId && s.product_id !== productId) continue;
      // A checkout that was never paid stays "pending"; it has no license to give.
      if (s.status === "pending") continue;
      await recordSubscription({
        email: s.customer.email,
        customerId: s.customer.customer_id,
        subscriptionId: s.subscription_id,
        productId: s.product_id,
        status: s.status,
        currentPeriodEnd: s.next_billing_date,
      });
      recorded++;
    }
  }
  return recorded;
}

type LicenseRow = {
  id: string;
  license_key: string;
  email: string;
  status: string;
  max_activations: number;
  activation_count: number;
  dodo_subscription_id: string | null;
};

/** Machine-readable failure reasons, so the Mac app can react without parsing messages. */
export type LicenseErrorCode =
  "missing_fields" | "not_found" | "revoked" | "limit_reached" | "not_activated" | "server_error";

export type LicenseCheck =
  | { valid: false; code: LicenseErrorCode; reason: string }
  | {
      valid: true;
      email: string;
      status: string;
      activations: number;
      maxActivations: number;
    };

async function findLicense(supabase: SupabaseClient, key: string): Promise<LicenseRow | null> {
  const { data } = await supabase
    .from("licenses")
    .select(
      "id, license_key, email, status, max_activations, activation_count, dodo_subscription_id",
    )
    .eq("license_key", key)
    .maybeSingle<LicenseRow>();
  return data;
}

/** Recounts activations so the stored count never drifts from the real rows. */
async function syncActivationCount(supabase: SupabaseClient, licenseId: string): Promise<number> {
  const { count } = await supabase
    .from("license_activations")
    .select("id", { count: "exact", head: true })
    .eq("license_id", licenseId);
  await supabase
    .from("licenses")
    .update({ activation_count: count ?? 0 })
    .eq("id", licenseId);
  return count ?? 0;
}

/**
 * Checks a key. With a device id, also requires that Mac to still be activated
 * (so a Mac that deactivated itself stops validating) and records it as seen.
 */
export async function verifyLicenseKey(
  rawKey: string,
  rawDeviceId?: string,
): Promise<LicenseCheck> {
  const key = normalizeKey(rawKey);
  if (!key) return { valid: false, code: "missing_fields", reason: "Enter a license key." };

  const supabase = adminClient();
  const data = await findLicense(supabase, key);

  if (!data) return { valid: false, code: "not_found", reason: "That license key was not found." };
  if (data.status !== "active")
    return { valid: false, code: "revoked", reason: "This license is no longer active." };

  const deviceId = rawDeviceId?.trim();
  if (deviceId) {
    const { data: activation } = await supabase
      .from("license_activations")
      .select("id")
      .eq("license_id", data.id)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (!activation)
      return {
        valid: false,
        code: "not_activated",
        reason: "This Mac is no longer activated for this license.",
      };
    await supabase
      .from("license_activations")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", activation.id);
  }

  return {
    valid: true,
    email: data.email,
    status: data.status,
    activations: data.activation_count,
    maxActivations: data.max_activations,
  };
}

export type LicenseResult = {
  ok: boolean;
  code?: LicenseErrorCode;
  message: string;
  activations?: number;
  maxActivations?: number;
};

export async function activateLicenseOnDevice(params: {
  rawKey: string;
  deviceId: string;
  deviceName?: string | null;
}): Promise<LicenseResult> {
  const key = normalizeKey(params.rawKey);
  const deviceId = params.deviceId.trim();
  if (!key || !deviceId)
    return {
      ok: false,
      code: "missing_fields",
      message: "License key and device id are required.",
    };

  const supabase = adminClient();
  const license = await findLicense(supabase, key);

  if (!license) return { ok: false, code: "not_found", message: "That license key was not found." };
  if (license.status !== "active")
    return { ok: false, code: "revoked", message: "This license is no longer active." };

  const { data: existing } = await supabase
    .from("license_activations")
    .select("id")
    .eq("license_id", license.id)
    .eq("device_id", deviceId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("license_activations")
      .update({ last_seen_at: new Date().toISOString(), device_name: params.deviceName ?? null })
      .eq("id", existing.id);
    return {
      ok: true,
      message: "This Mac is already activated.",
      activations: license.activation_count,
      maxActivations: license.max_activations,
    };
  }

  if (license.activation_count >= license.max_activations) {
    return {
      ok: false,
      code: "limit_reached",
      message:
        license.max_activations === 1
          ? "This license is already activated on another Mac. Open MacDissect on that Mac, go to Settings → License and click Deactivate This Mac, then try again."
          : `This license is already used on ${license.max_activations} Macs. Deactivate one of them in MacDissect, then try again.`,
    };
  }

  const { error } = await supabase.from("license_activations").insert({
    license_id: license.id,
    device_id: deviceId,
    device_name: params.deviceName ?? null,
  });
  // 23514: the database's activation-limit trigger won a race with another Mac.
  if (error?.code === "23514")
    return {
      ok: false,
      code: "limit_reached",
      message:
        "This license is already activated on another Mac. Open MacDissect on that Mac, go to Settings → License and click Deactivate This Mac, then try again.",
    };
  if (error)
    return { ok: false, code: "server_error", message: "Could not activate this Mac. Try again." };

  const nextCount = await syncActivationCount(supabase, license.id);

  return {
    ok: true,
    message: "MacDissect Pro is activated on this Mac.",
    activations: nextCount,
    maxActivations: license.max_activations,
  };
}

/** Frees a Mac's activation slot. Removing a Mac that isn't activated still succeeds. */
export async function deactivateLicenseOnDevice(params: {
  rawKey: string;
  deviceId: string;
}): Promise<LicenseResult> {
  const key = normalizeKey(params.rawKey);
  const deviceId = params.deviceId.trim();
  if (!key || !deviceId)
    return {
      ok: false,
      code: "missing_fields",
      message: "License key and device id are required.",
    };

  const supabase = adminClient();
  const license = await findLicense(supabase, key);
  if (!license) return { ok: false, code: "not_found", message: "That license key was not found." };

  await supabase
    .from("license_activations")
    .delete()
    .eq("license_id", license.id)
    .eq("device_id", deviceId);
  const activations = await syncActivationCount(supabase, license.id);

  return {
    ok: true,
    message: "This Mac was deactivated.",
    activations,
    maxActivations: license.max_activations,
  };
}
