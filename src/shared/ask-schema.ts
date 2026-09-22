import { z } from 'zod';

export const askSchema = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        question: z.string().trim().min(1).max(500),
        header: z.string().trim().min(1).max(40).optional(),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.union([
              z.string().trim().min(1).max(120),
              z.strictObject({
                label: z.string().trim().min(1).max(120),
                description: z.string().trim().min(1).max(300).optional(),
                recommended: z.boolean().optional(),
              }),
            ]),
          )
          .min(2)
          .max(4)
          .optional(),
      }),
    )
    .min(1)
    .max(3),
});
