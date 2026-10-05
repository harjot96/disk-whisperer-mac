import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  Copy,
  CreditCard,
  Laptop,
  Loader2,
  Minus,
  PartyPopper,
  Sparkles,
} from "lucide-react";
import {
  PRO_PLAN_DEFAULT,
  createDodoCheckout,
  getLaunchOffer,
  getProPlan,
  type ProPlan,
} from "@/lib/dodo.functions";
import { billingFaqs, plans } from "@/components/landing/content";
import { DownloadButton } from "@/components/site/DownloadButton";
import { FaqList } from "@/components/site/FaqList";
import { PageShell } from "@/components/site/SiteFooter";
import { supabase } from "@/integrations/supabase/client";
import { trackEvent } from "@/lib/firebase";
import {
  Reveal,
  Stagger,
  StaggerItem,
  WordReveal,
  fadeUp,
  staggerParent,
} from "@/components/site/motion";
import { faqJsonLd, pageHead, softwareJsonLd } from "@/lib/seo";

export const Route = createFileRoute("/pricing")({
  head: () =>
    pageHead({
      path: "/pricing",
      title: "MacDissect Pricing – Free Mac Disk Analyzer, Pro $10 Lifetime",
      description:
        "MacDissect is free to scan and visualize your home folder. Pro is a one-time $10 lifetime license for full-Mac and any-folder scans, Smart Cleanup, History and monitoring. The first 50 licenses are free.",
      jsonLd: [softwareJsonLd, faqJsonLd(billingFaqs)],
    }),
  loader: async () => {
    const [plan, offer] = await Promise.all([getProPlan(), getLaunchOffer()]);
    return { plan, offer };
  },
  component: PricingPage,
});

function formatPrice(plan: ProPlan) {
  const whole = plan.amount % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(plan.amount / 100);
}

function intervalLabel(plan: ProPlan) {
  if (!plan.interval) return "once, for life";
  return plan.intervalCount > 1
    ? `every ${plan.intervalCount} ${plan.interval}s`
    : `per ${plan.interval}`;
}

const proHighlights = [
  "Scan your entire Mac, any folder or external drive",
  "Smart Cleanup across 14 categories",
  "History with size-over-time charts",
  "Menu bar monitor and low-space alerts",
  "One license key for one Mac",
];

function PricingPage() {
  // Live price from Dodo when configured, otherwise the advertised $10 lifetime plan.
  const loaderData = Route.useLoaderData();
  const plan = loaderData.plan ?? PRO_PLAN_DEFAULT;
  const offer = loaderData.offer;
  const startCheckout = useServerFn(createDodoCheckout);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [purchased, setPurchased] = useState(false);
  // A free launch claim hands back its key immediately — nothing else is going to show it to
  // them, since a $0 claim never gets a Dodo receipt email.
  const [freeLicenseKey, setFreeLicenseKey] = useState<string | null>(null);
  // Signed-in buyers pay with their account email, so the license shows up on /account.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const sessionEmail = data.session?.user.email;
      if (sessionEmail) {
        setAccountEmail(sessionEmail);
        setEmail(sessionEmail);
      }
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("purchased") === "1" || params.get("subscribed") === "1") {
      setPurchased(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name) {
      toast.error(`Enter your name and email to ${offer.active ? "claim" : "buy"} Pro.`);
      return;
    }
    setBusy(true);
    try {
      const result = await startCheckout({ data: { email, name } });
      if (result.ok) {
        void trackEvent("begin_checkout", {
          is_free_offer: Boolean(offer.active && result.freeLicense),
        });
        // A free launch claim is issued immediately, with no Dodo checkout to redirect to.
        if (result.freeLicense) {
          setFreeLicenseKey(result.licenseKey);
          setPurchased(true);
          return;
        }
        if (offer.active) toast.message("The free launch licenses just ran out. Pro is $10, once.");
        window.location.href = result.checkoutUrl;
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell>
      <section className="relative isolate overflow-hidden px-6 pt-36 pb-10 text-center sm:pt-44">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[radial-gradient(50%_60%_at_50%_0%,rgba(255,201,60,0.28),transparent)]"
        />
        <motion.span
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xs font-bold tracking-[0.2em] text-ink/45 uppercase"
        >
          Pricing
        </motion.span>
        <h1 className="mx-auto mt-3 max-w-3xl font-display text-[clamp(2.6rem,6.5vw,5rem)] leading-[0.95] font-extrabold tracking-tight">
          <WordReveal text="Free to explore." />
          <br />
          <WordReveal text="Pro to clean up." className="text-coral" delay={0.2} />
        </h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
          className="mx-auto mt-5 max-w-xl text-lg text-ink/65"
        >
          The essentials are always free. Pro is a one-time {formatPrice(plan)} for every feature,
          on one Mac, for life. No subscription, nothing to renew.
        </motion.p>
      </section>

      <AnimatePresence>
        {purchased && (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            className="mx-auto mb-6 max-w-4xl rounded-2xl bg-mint px-5 py-4 font-semibold"
            role="status"
          >
            <div className="flex items-center gap-3">
              <PartyPopper className="size-5 shrink-0" />
              <span className="flex-1">
                {freeLicenseKey
                  ? "You've got MacDissect Pro for life! Save your license key below — it won't be shown again here."
                  : "You've got MacDissect Pro for life! Sign in with the same email to get your license key."}
              </span>
              {!freeLicenseKey && (
                <Link to="/auth" className="rounded-xl bg-ink px-4 py-2 text-sm text-cream">
                  Sign in
                </Link>
              )}
            </div>
            {freeLicenseKey && (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-ink px-4 py-3 text-cream">
                <code className="min-w-0 flex-1 font-mono text-sm font-bold tracking-wider break-all select-all sm:text-base">
                  {freeLicenseKey}
                </code>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(freeLicenseKey);
                      toast.success(
                        "License key copied. Paste it into MacDissect → Settings → License.",
                      );
                    } catch {
                      toast.error("Couldn't copy. Select the key and copy it manually.");
                    }
                  }}
                  className="flex items-center gap-2 rounded-xl border border-cream/20 px-4 py-2.5 text-sm font-bold transition-colors hover:bg-cream/10"
                >
                  <Copy className="size-4" /> Copy
                </button>
                <DownloadButton variant="sun" className="px-4 py-2.5 text-sm" />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.section
        initial="hidden"
        animate="show"
        variants={staggerParent(0.12, 0.3)}
        className="mx-auto grid max-w-5xl gap-5 px-6 pb-20 md:grid-cols-5"
      >
        {/* Free */}
        <motion.div
          variants={fadeUp}
          className="flex flex-col rounded-[2rem] border border-ink/10 bg-cream p-8 md:col-span-2"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-sky">
            <Laptop className="size-5" />
          </span>
          <h2 className="mt-5 font-display text-2xl font-bold">Free</h2>
          <p className="mt-1 text-ink/60">What keeps working without Pro.</p>
          <p className="mt-6 font-display text-5xl font-extrabold">Included</p>
          <ul className="mt-6 space-y-3 text-sm">
            {plans
              .filter((p) => p.free)
              .map((p) => (
                <li key={p.feature} className="flex gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-mint" strokeWidth={3} />
                  {p.feature}
                </li>
              ))}
          </ul>
          <div className="mt-auto pt-8">
            <DownloadButton variant="light" label="Download free" />
            <p className="mt-3 text-sm text-ink/50">
              These features are free forever, no plan needed.
            </p>
          </div>
        </motion.div>

        {/* Pro */}
        <motion.div
          variants={fadeUp}
          id="buy"
          className="relative scroll-mt-28 overflow-hidden rounded-[2rem] bg-ink p-8 text-cream shadow-[6px_6px_0_0_#FFC93C] sm:shadow-[10px_10px_0_0_#FFC93C] md:col-span-3"
        >
          <motion.div
            aria-hidden
            className="absolute -top-32 -right-32 size-80 rounded-full bg-[conic-gradient(from_0deg,#34d399,#38bdf8,#a78bfa,#ff6b6b,#ffc93c,#34d399)] opacity-25 blur-3xl"
            animate={{ rotate: 360 }}
            transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
          />
          <div className="relative">
            <div className="flex items-center justify-between">
              <span className="grid size-11 place-items-center rounded-2xl bg-sun text-ink">
                <Sparkles className="size-5" />
              </span>
              {offer.active ? (
                <span className="rounded-full bg-sun px-3 py-1 text-xs font-bold text-ink">
                  Launch offer · {offer.remaining} of {offer.limit} free left
                </span>
              ) : (
                <span className="rounded-full border border-cream/20 px-3 py-1 text-xs font-bold">
                  Lifetime license
                </span>
              )}
            </div>
            <h2 className="mt-5 font-display text-2xl font-bold">MacDissect Pro</h2>
            <div className="mt-4 flex items-baseline gap-3">
              {offer.active ? (
                <>
                  <span className="font-display text-6xl font-extrabold tracking-tight">$0</span>
                  <span className="font-display text-2xl font-bold text-cream/40 line-through">
                    {formatPrice(plan)}
                  </span>
                  <span className="text-cream/60">for life</span>
                </>
              ) : (
                <>
                  <span className="font-display text-6xl font-extrabold tracking-tight">
                    {formatPrice(plan)}
                  </span>
                  <span className="text-cream/60">{intervalLabel(plan)}</span>
                </>
              )}
            </div>
            <p className="mt-1 text-sm text-cream/50">
              {offer.active
                ? `Free for the first ${offer.limit} people, then ${formatPrice(plan)} once · nothing to renew`
                : plan.interval
                  ? "Plus applicable tax"
                  : `Pay once, keep Pro forever · ${plan.taxInclusive ? "tax included" : "plus applicable tax"}`}
            </p>

            <Stagger as="ul" className="mt-6 grid gap-2.5 text-sm sm:grid-cols-2" gap={0.05}>
              {proHighlights.map((h) => (
                <StaggerItem as="li" key={h} className="flex gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-sun" strokeWidth={3} />
                  {h}
                </StaggerItem>
              ))}
            </Stagger>

            <form onSubmit={handleCheckout} className="mt-8 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-bold tracking-wide text-cream/60 uppercase">
                Name
                <input
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="mt-1.5 w-full rounded-xl border border-cream/15 bg-cream/5 px-4 py-3 text-sm font-medium text-cream normal-case outline-none placeholder:text-cream/30 focus:border-sun focus:bg-cream/10"
                />
              </label>
              <label className="text-xs font-bold tracking-wide text-cream/60 uppercase">
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={accountEmail !== null}
                  title={
                    accountEmail
                      ? "Your license is linked to the account you're signed in with."
                      : undefined
                  }
                  placeholder="you@example.com"
                  className="mt-1.5 w-full rounded-xl border border-cream/15 bg-cream/5 px-4 py-3 text-sm font-medium text-cream normal-case outline-none placeholder:text-cream/30 read-only:text-cream/70 focus:border-sun focus:bg-cream/10"
                />
              </label>
              {accountEmail && (
                <p className="-mt-1 text-xs text-cream/50 normal-case sm:col-span-2">
                  Signed in as {accountEmail}. Your license key will appear on your account page.
                </p>
              )}
              <motion.button
                type="submit"
                disabled={busy}
                whileHover={busy ? {} : { y: -2 }}
                whileTap={busy ? {} : { scale: 0.98 }}
                className="flex items-center justify-center gap-2 rounded-2xl bg-sun px-6 py-4 text-lg font-bold text-ink disabled:opacity-60 sm:col-span-2"
              >
                {busy ? (
                  <>
                    <Loader2 className="size-5 animate-spin" /> Opening secure checkout…
                  </>
                ) : (
                  <>
                    {offer.active ? "Claim free lifetime license" : "Buy lifetime license"}{" "}
                    <ArrowRight className="size-5" />
                  </>
                )}
              </motion.button>
            </form>
            <p className="mt-3 flex items-center justify-center gap-2 text-center text-xs text-cream/45">
              <CreditCard className="size-3.5" /> Secure checkout by Dodo Payments
            </p>
          </div>
        </motion.div>
      </motion.section>

      <section className="mx-auto max-w-5xl px-6 pb-20">
        <Reveal>
          <h2 className="font-display text-3xl font-extrabold tracking-tight">Compare plans</h2>
        </Reveal>
        <Reveal
          delay={0.1}
          className="mt-6 overflow-x-auto rounded-3xl border border-ink/10 bg-cream"
        >
          <table className="w-full min-w-[30rem] text-left text-sm">
            <thead>
              <tr className="border-b border-ink/10">
                <th className="px-6 py-4 font-display text-base font-bold">Feature</th>
                <th className="w-24 px-6 py-4 text-center font-display text-base font-bold">
                  Free
                </th>
                <th className="w-24 px-6 py-4 text-center font-display text-base font-bold">Pro</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p, i) => (
                <motion.tr
                  key={p.feature}
                  initial={{ opacity: 0, x: -12 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.04 }}
                  className="border-b border-ink/5 transition-colors last:border-0 hover:bg-paper"
                >
                  <td className="px-6 py-4 font-medium">{p.feature}</td>
                  <td className="px-6 py-4 text-center">
                    {p.free ? (
                      <Check className="mx-auto size-4 text-ink" strokeWidth={3} />
                    ) : (
                      <Minus className="mx-auto size-4 text-ink/25" />
                    )}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <Check className="mx-auto size-4 text-mint" strokeWidth={3} />
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </section>

      <section id="billing" className="mx-auto max-w-3xl scroll-mt-24 px-6 pb-16">
        <Reveal className="text-center">
          <h2 className="font-display text-3xl font-extrabold tracking-tight">Billing questions</h2>
        </Reveal>
        <Reveal delay={0.1} className="mt-8">
          <FaqList items={billingFaqs} />
        </Reveal>
        <p className="mt-6 text-center text-sm text-ink/55">
          Already have Pro?{" "}
          <Link to="/account" className="font-semibold text-ink underline underline-offset-4">
            Get your license key
          </Link>
        </p>
      </section>
    </PageShell>
  );
}
