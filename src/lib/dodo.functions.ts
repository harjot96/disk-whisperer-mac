import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
});

function dodoBaseUrl() {
  return process.env["DODO_ENVIRONMENT"] === "live"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";
}

export const createDodoCheckout = createServerFn({ method: "POST" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    const apiKey = process.env["DODO_PAYMENTS_API_KEY"];
    const productId = process.env["DODO_PRODUCT_ID"];
    if (!apiKey || !productId) {
      return { ok: false as const, error: "Payments are not configured yet." };
    }

    const origin =
      process.env["SITE_URL"] ??
      "https://project--8213ab52-6526-4d49-8898-7f68c648d679.lovable.app";

    const license = await import("./license.server");
    // A lifetime license never needs buying twice, and each person gets one free launch license.
    if (await license.hasActiveLicense(data.email)) {
      return {
        ok: false as const,
        error: "This email already has a MacDissect Pro license. Sign in to see your key.",
      };
    }

    const promoCode = process.env["DODO_LAUNCH_DISCOUNT_CODE"];
    const promoOpen =
      !!promoCode && (await license.countFreeLicenseClaims()) < license.FREE_LICENSE_LIMIT;

    // A 100%-off launch claim is issued directly instead of round-tripping through Dodo's hosted
    // checkout: Dodo can't skip its card-entry form on a $0 one-time purchase (only subscriptions
    // support "Card-Optional at $0 Price"), so sending free claimers there just makes them click
    // through a payment screen for an order that's already free.
    if (promoOpen) {
      const licenseKey = await license.claimFreeLicense({
        email: data.email,
        productId,
        redirectTo: `${origin}/account`,
      });
      if (licenseKey) {
        return { ok: true as const, checkoutUrl: null, freeLicense: true, licenseKey };
      }
      // Lost the race: the limit filled between the count check and the claim. Fall through to
      // the regular paid checkout below.
    }

    const res = await fetch(`${dodoBaseUrl()}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: data.email, name: data.name },
        return_url: `${origin}/pricing?purchased=1`,
      }),
    });

    if (!res.ok) {
      console.error("Dodo checkout failed:", res.status, await res.text());
      return { ok: false as const, error: "Could not start checkout. Please try again." };
    }

    const payload = (await res.json()) as { checkout_url?: string };
    if (!payload.checkout_url) {
      return { ok: false as const, error: "Checkout link missing from response." };
    }
    return { ok: true as const, checkoutUrl: payload.checkout_url, freeLicense: false };
  });

export type LaunchOffer = { limit: number; claimed: number; remaining: number; active: boolean };

/** Public launch-offer status for the promotion banner and pricing page. */
export const getLaunchOffer = createServerFn({ method: "GET" }).handler(
  async (): Promise<LaunchOffer> => {
    const { countFreeLicenseClaims, FREE_LICENSE_LIMIT } = await import("./license.server");
    const configured = !!process.env["DODO_LAUNCH_DISCOUNT_CODE"];
    let claimed = 0;
    try {
      claimed = await countFreeLicenseClaims();
    } catch (e) {
      console.error("Could not count free launch licenses:", e);
    }
    const remaining = Math.max(0, FREE_LICENSE_LIMIT - claimed);
    return { limit: FREE_LICENSE_LIMIT, claimed, remaining, active: configured && remaining > 0 };
  },
);

export type ProPlan = {
  /** Price in the currency's smallest unit (e.g. cents). */
  amount: number;
  currency: string;
  /** e.g. "year" or "month"; null for a one-time (lifetime) price. */
  interval: string | null;
  intervalCount: number;
  taxInclusive: boolean;
  /** Free trial configured on the Dodo product, in days (0 when none). */
  trialDays: number;
};

/**
 * The advertised Pro plan: $10 once, for life. The Dodo product (DODO_PRODUCT_ID) should be a
 * one-time price of 1000 USD cents so checkout matches this.
 */
export const PRO_PLAN_DEFAULT: ProPlan = {
  amount: 1000,
  currency: "USD",
  interval: null,
  intervalCount: 1,
  taxInclusive: false,
  trialDays: 0,
};

/** Reads the live price of the Pro product from Dodo, so the pricing page never goes stale. */
export const getProPlan = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProPlan | null> => {
    const apiKey = process.env["DODO_PAYMENTS_API_KEY"];
    const productId = process.env["DODO_PRODUCT_ID"];
    if (!apiKey || !productId) return null;

    try {
      const res = await fetch(`${dodoBaseUrl()}/products/${encodeURIComponent(productId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const product = (await res.json()) as {
        price?: {
          type?: string;
          price?: number;
          fixed_price?: number;
          currency?: string;
          payment_frequency_interval?: string;
          payment_frequency_count?: number;
          tax_inclusive?: boolean;
          trial_period_days?: number;
        };
      };
      const price = product.price;
      const amount = price?.price ?? price?.fixed_price;
      if (!price || typeof amount !== "number" || !price.currency) return null;
      const recurring = price.type !== "one_time_price";
      const plan: ProPlan = {
        amount,
        currency: price.currency.toUpperCase(),
        interval: recurring ? (price.payment_frequency_interval ?? "year").toLowerCase() : null,
        intervalCount: price.payment_frequency_count ?? 1,
        taxInclusive: price.tax_inclusive ?? false,
        trialDays: recurring ? (price.trial_period_days ?? 0) : 0,
      };
      if (
        plan.amount !== PRO_PLAN_DEFAULT.amount ||
        plan.currency !== PRO_PLAN_DEFAULT.currency ||
        plan.interval !== PRO_PLAN_DEFAULT.interval ||
        plan.intervalCount !== PRO_PLAN_DEFAULT.intervalCount
      ) {
        console.warn("Dodo product price differs from the advertised $10 lifetime plan:", plan);
      }
      return plan;
    } catch (e) {
      console.error("Could not load Dodo product price:", e);
      return null;
    }
  },
);
