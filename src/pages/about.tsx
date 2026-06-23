import Footer from '../components/footer';

const About = () => (
  <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 16px' }}>
    <h2 style={{ marginBottom: 12 }}>About Infrared Explorer</h2>
    <p style={{ marginBottom: 12 }}>
      Infrared Explorer lets you replay infrared thermal recordings and analyze them in the browser: place thermometers
      and measuring areas, plot temperature over time T(t) and over space T(x)/T(y), overlay isotherms, annotate frames,
      and save or share your analyses.
    </p>
    <p style={{ marginBottom: 12 }}>
      All thermal decoding runs fully client-side — no server round-trips are needed to read temperatures.
    </p>

    <h3 style={{ margin: '16px 0 8px' }}>Credits</h3>
    <p style={{ marginBottom: 12 }}>
      Brought to you by the{' '}
      <a href="https://intofuture.org" target="_blank" rel="noreferrer">
        Institute for Future Intelligence
      </a>
      .
    </p>
    <p style={{ marginBottom: 12, fontSize: 13, color: 'var(--ifi-grey)' }}>
      This material is based upon work supported by the National Science Foundation under grants #2054079 and #2131097.
      Any opinions, findings, and conclusions or recommendations expressed in this material are those of the authors and
      do not necessarily reflect the views of the National Science Foundation.
    </p>

    <Footer />
  </div>
);

export default About;
