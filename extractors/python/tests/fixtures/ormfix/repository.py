from abc import ABC, abstractmethod


class Repository(ABC):
    @abstractmethod
    def get(self, key):
        pass


class UserRepository(Repository):
    def get(self, key):
        return None
