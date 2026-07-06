function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    username: user.username,
    email: user.email,
    company: user.company,
    country: user.country,
    countryCode: user.countryCode,
    phoneCode: user.phoneCode,
    phone: user.phone,
    profilePicture: user.profilePicture,
    role: user.role,
    status: user.status,
    isEmailVerified: user.isEmailVerified,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
  };
}

module.exports = { publicUser };
