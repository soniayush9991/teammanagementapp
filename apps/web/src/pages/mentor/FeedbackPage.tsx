import { Card, EmptyState } from '../../components/ui';
import { ReportCardFrame } from '../../components/mentor/parts';

/** M7: suggestions tied to what actually moved the score, supportive in tone. */
export function FeedbackPage(): JSX.Element {
  return (
    <ReportCardFrame title="Suggestions">
      {(card) => {
        const nudges = card.nudges;
        const improvement = nudges.filter((nudge) => nudge.code === 'most_improved');
        const focus = nudges.filter((nudge) => nudge.code !== 'most_improved');

        if (card.status === 'insufficient_data') {
          return (
            <Card>
              <EmptyState icon="○" title="No suggestions yet" description="Suggestions appear once there is enough evidence to score a period." />
            </Card>
          );
        }

        return (
          <>
            {improvement.map((nudge) => (
              <div key={nudge.code} className="notice notice--positive" role="note">
                <span aria-hidden="true">▲ </span>
                {nudge.message}
              </div>
            ))}

            {focus.length === 0 ? (
              <Card>
                <EmptyState icon="●" title="Nothing needs changing right now" description="Keep recording what you observe, exactly as it is." />
              </Card>
            ) : (
              <Card title="Where to focus">
                <ol className="suggestions">
                  {focus.map((nudge, index) => (
                    <li key={nudge.code} className="suggestions__item">
                      <span className="suggestions__rank" aria-hidden="true">
                        {index + 1}
                      </span>
                      <div>
                        {index === 0 && <p className="tiny">Biggest effect on your score</p>}
                        <p>{nudge.message}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            <p className="tiny">
              These suggestions are about the coverage and reliability of your records. Writing down a weak result or an
              area that needs improvement, when that is what you saw, never lowers your score.
            </p>
          </>
        );
      }}
    </ReportCardFrame>
  );
}
