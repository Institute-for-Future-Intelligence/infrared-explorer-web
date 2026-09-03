import { isSignInCancelled, signIn } from '../../services/auth';
import { PRIVACY_URL, TERMS_URL } from '../../utils/urls';

const SignInButton = () => {
  // Opens the provider chooser (components/signInDialog); a dismissed chooser is not an error.
  const handleSignIn = () => {
    signIn().catch((error) => {
      if (!isSignInCancelled(error)) console.error(error);
    });
  };

  return (
    <div className="signin-block">
      <button className="signInButton" onClick={handleSignIn}>
        Sign In
      </button>
      {/* Consent notice at the point of collection (the chooser dialog repeats it next to the provider
          buttons). Always one line: the full sentence where the header has room, and below 1200px
          (App.css) just the two links with a dot between them, so the notice survives any zoom level
          instead of vanishing. */}
      <span className="signin-legal">
        <span className="signin-legal-full">By signing in you agree to the </span>
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
          Terms
        </a>
        <span className="signin-legal-full"> and </span>
        <span className="signin-legal-short" aria-hidden="true">
          {' · '}
        </span>
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </a>
      </span>
    </div>
  );
};

export default SignInButton;
