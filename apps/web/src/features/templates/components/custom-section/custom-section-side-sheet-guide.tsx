'use client';

import { Card, CardContent } from '@ui/src';
import { useAppName } from '@/config/app-branding';

const templateCreationTips = [
  'Start with a brief session overview.',
  'Use markdown headings (## Summary, ## Action Items) to define sections.',
  'List key items to capture (eg. key points, decisions, follow-ups).',
  'Specify phrasing preferences and what to avoid.',
];

const CustomSectionSideSheetGuide = () => {
  const appName = useAppName();
  return (
    <Card className="border-0 rounded-none h-full">
      <CardContent className="space-y-3 sm:space-y-4 flex-1 overflow-y-auto">
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">Need help with creating template?</p>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Customize your template to better suit your workflow. You can write instructions in
            markdown to structure your notes.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-semibold">How Templates Work</p>
          <p className="text-xs sm:text-sm text-muted-foreground">
            {appName} will use these instructions as a guide whenever you record a session with this
            template. Describe what you want to see in the final note, rather than filling fixed
            fields.
          </p>
        </div>

        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">Tips</h3>
          <ul className="space-y-1 text-xs sm:text-sm text-muted-foreground list-disc pl-4">
            {templateCreationTips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
};

export default CustomSectionSideSheetGuide;
