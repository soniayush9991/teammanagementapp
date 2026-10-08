import { useRecognition } from '../../api/mentorAdmin';
import { Card, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui';
import { formatPeriod } from '../../components/mentor/format';
import { PeriodSelect, oneDecimal, useFilters } from '../../components/mentorAdmin/parts';

const VALUE_LABEL: Record<string, (value: number) => string> = {
  top_overall: (value) => `${oneDecimal(value)} overall`,
  most_improved: (value) => `+${value} points`,
  reliable_data: (value) => `${oneDecimal(value)} reliability`,
  strong_coverage: (value) => `${oneDecimal(value)} compliance`,
};

/** A7: positive recognition only. Nobody is listed for being ineligible. */
export function RecognitionPage(): JSX.Element {
  const { filters, set } = useFilters();
  const { data, isPending, error, refetch } = useRecognition(filters.period);

  return (
    <div className="stack">
      <div className="filters">
        <PeriodSelect value={filters.period} onChange={(period) => set({ period })} />
      </div>

      {isPending && <LoadingBlock rows={4} label="Loading recognition" />}
      {error && <ErrorBlock error={error} onRetry={() => void refetch()} />}

      {data && (
        <>
          <Card>
            <p>
              <strong>{formatPeriod(data.period.startDate, data.period.endDate)}</strong> · {data.eligible} of {data.mentorsConsidered} mentors are eligible.
            </p>
            <p className="muted">
              To be recognised a mentor needs a <strong>Final</strong> score, a data-reliability score of at least <strong>{data.qualityFloor}</strong>,
              and no record still under review. Recognition rewards trustworthy data, not the most positive-looking data.
            </p>
            <p className="tiny">
              {data.notEligible.notFinal + data.notEligible.openReview + data.notEligible.belowQualityFloor > 0
                ? `Not yet eligible: ${data.notEligible.notFinal} without a final score, ${data.notEligible.openReview} with a record still under review, ${data.notEligible.belowQualityFloor} below the reliability floor. They are not named here.`
                : 'Every mentor considered is eligible.'}
              {' '}This screen does not send messages; share results through your agreed channel.
            </p>
          </Card>

          <div className="grid grid--halves">
            {data.categories.map((category) => (
              <Card key={category.category} title={category.label}>
                {category.winners.length === 0 ? (
                  <EmptyState icon="○" title="No eligible mentor" description={category.category === 'most_improved' ? 'No eligible mentor improved on a comparable earlier period.' : undefined} />
                ) : (
                  <ul className="winners">
                    {category.winners.map((winner) => (
                      <li key={winner.mentorId}>
                        <span aria-hidden="true">★ </span>
                        <strong>{winner.name}</strong>
                        {winner.district && <span className="muted"> · {winner.district}</span>}
                        {winner.value !== null && <span className="block tiny">{VALUE_LABEL[category.category]?.(winner.value)}</span>}
                      </li>
                    ))}
                    {category.winners.length > 1 && <li className="tiny">Tied: every tied mentor is listed.</li>}
                  </ul>
                )}
              </Card>
            ))}
          </div>
          {!data.period.published && <p className="tiny">Mentors cannot see this period's report cards yet (shadow mode), so hold announcements until it is published.</p>}
        </>
      )}
    </div>
  );
}
