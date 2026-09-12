import { useNavigate } from 'react-router-dom';
import Logo from '../../assets/ie-logo.svg';

const Title = () => {
  const navigate = useNavigate();

  return (
    <div className="title" onClick={() => navigate('/')}>
      <img src={Logo} alt="Infrared Explorer" />
      <h2>Infrared Explorer</h2>
    </div>
  );
};

export default Title;
