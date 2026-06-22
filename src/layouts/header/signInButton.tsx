import { signIn } from '../../services/auth';

const SignInButton = () => {
  const handleSignIn = () => {
    signIn().catch((error) => console.error(error));
  };

  return (
    <button className="signInButton" onClick={handleSignIn}>
      Sign In
    </button>
  );
};

export default SignInButton;
