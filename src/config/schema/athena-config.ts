import { z } from "zod"

const PROVIDER_MODEL_PATTERN = /^[^/\s]+\/[^/\s]+$/

const ProviderModelSchema = z
  .string()
  .regex(PROVIDER_MODEL_PATTERN, "Model must use provider/model format")

const AthenaCouncilMemberSchema = z.object({
  name: z.string().trim().min(1),
  model: ProviderModelSchema,
})

export const AthenaConfigSchema = z
  .object({
    model: ProviderModelSchema.optional(),
    members: z.array(AthenaCouncilMemberSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>()

    for (const [index, member] of value.members.entries()) {
      const normalizedName = member.name.trim().toLowerCase()
      const existingIndex = seen.get(normalizedName)

      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["members", index, "name"],
          message: `Duplicate member name '${member.name}' (case-insensitive). First seen at members[${existingIndex}]`,
        })
        continue
      }

      seen.set(normalizedName, index)
    }
  })

export type AthenaConfig = z.infer<typeof AthenaConfigSchema>
