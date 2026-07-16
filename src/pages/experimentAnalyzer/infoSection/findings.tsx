import useCommonStore from '../../../stores/common';
import { Experiment } from '../../../types';
import { updateFindings } from '../../../services/experiments';
import Content from './content';

// The author's "What we found" section: a structured conclusion, separate from the free description,
// sitting in the Info tab under it. Reuses the same editable-text control (Content) with a findings
// save + store field. A viewer sees it only once the owner has written one; the owner always sees it
// (an empty prompt inviting them to add their conclusion). This is the first structured field — the
// research-question / hypothesis sections are a later step.
const Findings = ({ experiment }: { experiment: Experiment }) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && experiment.ownerId === user.id;
  const hasFindings = !!experiment.findings?.trim();

  // Nothing to show and not the owner → render nothing (a findings-less experiment, for a viewer).
  if (!hasFindings && !isOwner) return null;

  return (
    <section style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 6px', color: 'var(--ifi-ink)' }}>What we found</h3>
      <Content
        key={experiment.id}
        expId={experiment.id}
        value={experiment.findings ?? ''}
        ownerId={experiment.ownerId}
        onSave={updateFindings}
        storeField="findings"
        placeholder="What did the thermal data show?"
        addLabel="Add your findings"
        editTitle="Edit findings"
      />
    </section>
  );
};

export default Findings;
