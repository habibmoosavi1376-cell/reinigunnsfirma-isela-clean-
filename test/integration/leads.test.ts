import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLeadContact, createLead, suppressLeadContact, transitionLead } from "@isela/crm";
import { and, asc, eq, schema } from "@isela/database";
import { expectDomainError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  contextForRole,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let dispatcher: Ctx;

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  await db
    .insert(schema.leadSource)
    .values({
      key: "unreviewed-business-search",
      name: "Unreviewed business search",
      providerKind: "BUSINESS_SEARCH",
      legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
      retentionDays: 90,
      rateLimitPerMinute: 10,
      enabled: false,
    })
    .onConflictDoNothing();
});

async function newLead(sourceKey = "internal-website-form") {
  return createLead(dispatcher, {
    sourceKey,
    companyName: `Firma ${Math.random().toString(36).slice(2, 8)}`,
  });
}

describe("lead creation", () => {
  it("creates leads from approved sources in status DISCOVERED", async () => {
    const leadId = await newLead();
    const [lead] = await db.select().from(schema.lead).where(eq(schema.lead.id, leadId));
    expect(lead?.status).toBe("DISCOVERED");
  });

  it("refuses disabled or unreviewed providers", async () => {
    await expectDomainError(newLead("unreviewed-business-search"), "POLICY_VIOLATION");
  });

  it("deduplicates by source reference", async () => {
    const input = {
      sourceKey: "referral",
      sourceReference: `ref-${Date.now()}`,
      companyName: "Dup GmbH",
    };
    await createLead(dispatcher, input);
    await expectDomainError(createLead(dispatcher, input), "CONFLICT");
  });

  it("rejects non-http websites and unknown fields", async () => {
    await expectDomainError(
      createLead(dispatcher, {
        sourceKey: "referral",
        companyName: "X",
        website: "javascript:alert(1)",
      }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      createLead(dispatcher, { sourceKey: "referral", companyName: "X", status: "WON" }),
      "VALIDATION_FAILED",
    );
  });

  it("is not available to customers or staff", async () => {
    const staff = await contextForRole(db, "STAFF");
    await expectDomainError(
      createLead(staff, { sourceKey: "referral", companyName: "X" }),
      "FORBIDDEN",
    );
  });
});

describe("lead pipeline", () => {
  it("walks through a full pipeline with history and audit trail", async () => {
    const leadId = await newLead();
    await addLeadContact(
      dispatcher,
      {
        leadId,
        fullName: "Erika Muster",
        email: uniqueEmail("lead"),
        legalBasis: "GDPR_ART6_1B_CONTRACT",
        consentStatus: "NOT_REQUIRED",
      },
      TEST_CRM_CONFIG,
    );
    const path = [
      "QUALIFIED",
      "OUTREACH_DRAFTED",
      "CONTACTED",
      "RESPONSE",
      "QUALIFIED_OPPORTUNITY",
      "QUOTE_REQUEST",
      "QUOTE_SENT",
      "NEGOTIATION",
      "WON",
    ];
    for (const to of path) {
      await transitionLead(dispatcher, { leadId, to });
    }
    const history = await db
      .select({
        from: schema.leadStatusTransition.fromStatus,
        to: schema.leadStatusTransition.toStatus,
      })
      .from(schema.leadStatusTransition)
      .where(eq(schema.leadStatusTransition.leadId, leadId))
      .orderBy(asc(schema.leadStatusTransition.createdAt));
    expect(history.map((h) => h.to)).toEqual(path);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, leadId),
          eq(schema.auditLog.action, "lead.status_changed"),
        ),
      );
    expect(audit.length).toBe(path.length);
    await expectDomainError(
      transitionLead(dispatcher, { leadId, to: "FOLLOW_UP" }),
      "INVALID_STATE_TRANSITION",
    );
  });

  it("rejects invalid transitions and leaves the status unchanged", async () => {
    const leadId = await newLead();
    await expectDomainError(
      transitionLead(dispatcher, { leadId, to: "WON" }),
      "INVALID_STATE_TRANSITION",
    );
    const [lead] = await db
      .select({ status: schema.lead.status })
      .from(schema.lead)
      .where(eq(schema.lead.id, leadId));
    expect(lead?.status).toBe("DISCOVERED");
  });

  it("requires a reason for LOST", async () => {
    const leadId = await newLead();
    await expectDomainError(
      transitionLead(dispatcher, { leadId, to: "LOST" }),
      "VALIDATION_FAILED",
    );
    await transitionLead(dispatcher, { leadId, to: "LOST", reason: "kein Bedarf" });
  });

  it("cannot contact a lead without a contactable contact", async () => {
    const leadId = await newLead();
    await transitionLead(dispatcher, { leadId, to: "QUALIFIED" });
    await transitionLead(dispatcher, { leadId, to: "OUTREACH_DRAFTED" });
    await expectDomainError(
      transitionLead(dispatcher, { leadId, to: "CONTACTED" }),
      "POLICY_VIOLATION",
    );
  });

  it("does not allow setting a status through other fields", async () => {
    const leadId = await newLead();
    await expectDomainError(
      transitionLead(dispatcher, { leadId, to: "QUALIFIED", status: "WON" }),
      "VALIDATION_FAILED",
    );
  });
});

describe("objections and suppression", () => {
  it("suppresses a contact globally so it cannot be contacted via another lead", async () => {
    const email = uniqueEmail("objection");
    const first = await newLead();
    const { contactId } = await addLeadContact(
      dispatcher,
      { leadId: first, fullName: "Max", email, legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST" },
      TEST_CRM_CONFIG,
    );
    await suppressLeadContact(
      dispatcher,
      { contactId, reason: "Widerspruch per Telefon" },
      TEST_CRM_CONFIG,
    );

    const second = await newLead();
    const added = await addLeadContact(
      dispatcher,
      {
        leadId: second,
        fullName: "Max",
        email: email.toUpperCase(),
        legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
      },
      TEST_CRM_CONFIG,
    );
    expect(added.suppressed).toBe(true);

    await transitionLead(dispatcher, { leadId: second, to: "QUALIFIED" });
    await transitionLead(dispatcher, { leadId: second, to: "OUTREACH_DRAFTED" });
    await expectDomainError(
      transitionLead(dispatcher, { leadId: second, to: "CONTACTED" }),
      "POLICY_VIOLATION",
    );

    const stored = await db.select().from(schema.contactSuppression);
    expect(stored.every((s) => !s.valueHash.includes("@"))).toBe(true);
  });

  it("requires a contact channel", async () => {
    const leadId = await newLead();
    await expectDomainError(
      addLeadContact(
        dispatcher,
        { leadId, fullName: "No channel", legalBasis: "GDPR_ART6_1B_CONTRACT" },
        TEST_CRM_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
  });
});
