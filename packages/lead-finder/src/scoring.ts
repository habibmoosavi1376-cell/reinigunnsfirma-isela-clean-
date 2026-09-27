import { z } from "@isela/validation";

/** Setting `lead.scoring`: weights of the explainable lead score (PRODUCT_SPEC §5.4). */
export const leadScoringSchema = z
  .strictObject({
    weights: z.strictObject({
      areaFit: z.number().int().min(0).max(100),
      segmentFit: z.number().int().min(0).max(100),
      demandSignal: z.number().int().min(0).max(100),
      volumePotential: z.number().int().min(0).max(100),
      recurrencePotential: z.number().int().min(0).max(100),
      dataQuality: z.number().int().min(0).max(100),
    }),
  })
  .refine((value) => Object.values(value.weights).reduce((sum, w) => sum + w, 0) === 100, {
    message: "Lead scoring weights must add up to 100",
    path: ["weights"],
  });

export type LeadScoringConfig = z.infer<typeof leadScoringSchema>;

export const DEFAULT_LEAD_SCORING: LeadScoringConfig = {
  weights: {
    areaFit: 25,
    segmentFit: 15,
    demandSignal: 25,
    volumePotential: 15,
    recurrencePotential: 10,
    dataQuality: 10,
  },
};
