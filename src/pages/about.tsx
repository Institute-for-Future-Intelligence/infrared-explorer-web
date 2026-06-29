import labBackground from '../assets/lab-background2.png';
import { useIsMobile } from '../hooks/useIsMobile';

/*
 * About page — ported from Telelab for parity: faint lab watermark on a dark
 * backdrop, antiquewhite text, and the "brought to you by" credits. "†" marks
 * past contributors.
 */

const COLOR = 'antiquewhite';

const About = () => {
  const isMobile = useIsMobile();
  // On phones the 4-column credits table can't fit; tighten cell padding and let
  // it scroll horizontally inside its own box rather than overflowing the page.
  const cellPad = isMobile ? '0 8px' : '0 24px';

  return (
    <div
      style={{
        position: 'relative',
        margin: -8, // cancel the .content padding so the backdrop is full-bleed
        minHeight: 'calc(100% + 16px)',
        overflow: 'hidden',
        background: '#3b3b3b',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <img
        src={labBackground}
        alt=""
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0.12,
          pointerEvents: 'none',
        }}
      />

      <div style={{ position: 'relative', flex: 1, color: COLOR, padding: '40px 16px 24px' }}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', color: COLOR, marginBottom: 8 }}>This product is brought to you by</h2>

          <p style={{ textAlign: 'center', fontSize: 12, marginBottom: 16 }}>
            <a
              href="https://intofuture.org/telelab-terms.html"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: COLOR }}
            >
              Terms of Service
            </a>
            {'   |   '}
            <a
              href="https://intofuture.org/telelab-privacy.html"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: COLOR }}
            >
              Privacy Policy
            </a>
          </p>

          <hr
            style={{
              width: isMobile ? '100%' : '70%',
              margin: '0 auto 20px',
              border: 0,
              borderTop: `1px solid ${COLOR}`,
              opacity: 0.5,
            }}
          />

          <div style={{ overflowX: isMobile ? 'auto' : undefined }}>
            <table style={{ margin: '0 auto', borderCollapse: 'collapse', fontSize: 'small' }}>
              <tbody>
                <tr style={{ verticalAlign: 'top' }}>
                  <td style={{ padding: cellPad }}>
                    <h3 style={{ color: COLOR, marginBottom: 6 }}>Software</h3>
                    Amos Decker &#8224;
                    <br />
                    Xiaotong Ding
                    <br />
                    Chenglu Li &#8224;
                    <br />
                    Charles Xie
                    <br />
                    Xiaoyan Zhang &#8224;
                  </td>
                  <td style={{ padding: cellPad }}>
                    <h3 style={{ color: COLOR, marginBottom: 6 }}>Content</h3>
                    Rundong Jiang &#8224;
                    <br />
                    Charles Xie
                  </td>
                  <td style={{ padding: cellPad }}>
                    <h3 style={{ color: COLOR, marginBottom: 6 }}>Research</h3>
                    Xudong Huang &#8224;
                    <br />
                    Shannon Sung
                    <br />
                    Charles Xie
                  </td>
                  <td style={{ padding: cellPad }}>
                    <h3 style={{ color: COLOR, marginBottom: 6 }}>Support</h3>
                    Rundong Jiang &#8224;
                    <br />
                    Elena Sereiviene &#8224;
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 'smaller', margin: '24px 0 20px' }}>&#8224; Past contributor</p>

          <p style={{ fontSize: 'small', lineHeight: 1.5 }}>
            The National Science Foundation (NSF) of the United States generously provided funding for the research and
            development of this product through grant numbers 2054079 and 2131097. Any opinions, findings, and
            conclusions or recommendations expressed in this product, however, are those of the authors and do not
            necessarily reflect the views of NSF.
          </p>
        </div>
      </div>

      <div
        style={{
          position: 'relative',
          textAlign: 'center',
          color: COLOR,
          fontSize: 'smaller',
          padding: '8px 16px 16px',
        }}
      >
        &copy;{new Date().getFullYear()} Institute for Future Intelligence, Inc. All Rights Reserved.
      </div>
    </div>
  );
};

export default About;
